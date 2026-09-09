import { randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionContext, SessionStartEvent } from "@earendil-works/pi-coding-agent";
import type { IntercomExtensionChannel, IntercomExtensionEvent } from "pi-intercom/extension-api.ts";

export type Role = "worker" | "supervisor";
export interface View { id: string; text: string; reason: string; through?: string; backgroundQuiet: boolean }
interface Message { binding: string; role: Role; kind: "hello" | "view" | "steer" | "received"; id: string; text?: string; reason?: string; failure?: string; ready?: boolean; reply?: boolean; through?: string; backgroundQuiet?: boolean }
const STATE = "pi-goals-intercom";

export class GoalIntercom {
	private channel?: IntercomExtensionChannel;
	private ctx?: ExtensionContext;
	private stopped = false;
	private registered = false;
	private binding = "";
	private role: Role = "worker";
	private ready = false;
	private failure?: string;
	private peer?: string;
	private peerReady = false;
	private peerFailure?: string;
	private pending = new Map<string, Message>();
	private received = new Set<string>();
	private inbox = new Map<string, Message>();
	private deliveryTimer?: ReturnType<typeof setTimeout>;
	private idleChecks = 0;
	private delivering?: string;
	private compacting = false;
	private waiters = new Set<(error?: Error) => void>();
	latestView?: View;
	acknowledgedEntry?: string;
	onView: (view: View) => void = () => {};
	onSteer: (text: string) => void = () => {};
	onConnectionChange: (ctx: ExtensionContext) => void = () => {};

	constructor(private pi: ExtensionAPI) {
		pi.events.on("intercom:extension-registry-ready", () => this.register());
		this.register();
		pi.on("session_start", async (event, ctx) => {
			this.ctx = ctx;
			if (!this.channel) await this.loadIntercom(event, ctx);
		});
		pi.on("message_start", async event => {
			if (event.message.role !== "user") return;
			const content = event.message.content;
			const text = typeof content === "string" ? content : content.filter(part => part.type === "text").map(part => part.text).join("\n");
			for (const message of this.inbox.values()) {
				if (text !== this.deliveryText(message)) continue;
				this.inbox.delete(message.id);
				this.received.add(message.id);
				this.record("in", message);
				if (this.connected) this.publish({ binding: this.binding, role: this.role, kind: "received", id: message.id });
				this.delivering = undefined;
				this.idleChecks = 0;
				this.scheduleDelivery(0);
				break;
			}
		});
		pi.on("session_before_compact", async () => { this.compacting = true; });
		pi.on("session_compact", async () => { this.compacting = true; this.resumeDelivery(); });
		pi.on("session_compact_failed", async () => { this.compacting = true; this.resumeDelivery(); });
		pi.on("agent_settled", async () => this.resumeDelivery());
		pi.on("session_shutdown", async () => {
			if (this.deliveryTimer) clearTimeout(this.deliveryTimer);
			this.stopped = true;
			this.peerReady = false;
			for (const wake of this.waiters) wake();
		});
	}

	configure(binding: string, role: Role, ctx: ExtensionContext, ready = role === "worker"): void {
		for (const wake of this.waiters) wake(new Error("Supervision readiness wait cancelled by reconfiguration."));
		this.binding = binding;
		this.role = role;
		this.ctx = ctx;
		this.ready = ready;
		this.failure = undefined;
		this.peer = undefined;
		this.peerReady = false;
		this.peerFailure = undefined;
		this.pending.clear();
		this.received.clear();
		this.inbox.clear();
		this.delivering = undefined;
		this.idleChecks = 0;
		if (this.deliveryTimer) clearTimeout(this.deliveryTimer);
		this.deliveryTimer = undefined;
		this.latestView = undefined;
		this.acknowledgedEntry = undefined;
		for (const entry of ctx.sessionManager.getBranch?.() ?? ctx.sessionManager.getEntries()) {
			if (entry.type !== "custom" || entry.customType !== STATE) continue;
			const record = entry.data as { direction: string; message: Message };
			const message = record.message;
			if (message.binding !== binding) continue;
			if (record.direction === "out" && message.kind === "steer") this.pending.set(message.id, message);
			if (record.direction === "ack") {
				this.pending.delete(message.id);
				if (message.through) this.acknowledgedEntry = message.through;
			}
			if (record.direction === "queued") this.inbox.set(message.id, message);
			if (record.direction === "in") { this.received.add(message.id); this.inbox.delete(message.id); }
			if (message.kind === "view") this.latestView = { id: message.id, text: message.text!, reason: message.reason!, through: message.through, backgroundQuiet: message.backgroundQuiet === true };
		}
		this.hello();
		this.scheduleDelivery(0);
	}

	// End this plan's binding without disposing the session's transport.
	detach(): void {
		if (this.deliveryTimer) clearTimeout(this.deliveryTimer);
		this.deliveryTimer = undefined;
		this.inbox.clear();
		this.delivering = undefined;
		this.ready = false;
		this.hello();
		this.binding = "";
		this.peer = undefined;
		this.peerReady = false;
		this.latestView = undefined;
		this.pending.clear();
		for (const wake of this.waiters) wake(new Error("Supervision readiness wait cancelled: plan detached."));
		if (this.ctx) this.onConnectionChange(this.ctx);
	}

	failReady(reason: string): void { this.failure = reason; this.setReady(false); }
	markReady(): void { this.failure = undefined; this.setReady(true); this.resumeDelivery(); }
	markNotReady(): void { this.setReady(false); }
	private setReady(ready: boolean): void {
		if (this.stopped) return;
		this.ready = ready;
		this.hello();
		if (this.ctx) this.onConnectionChange(this.ctx);
	}
	get readinessFailure(): string | undefined { return this.failure; }
	get ended(): boolean { return this.stopped; }
	get bound(): boolean { return !this.stopped && Boolean(this.binding); }
	get peerPresent(): boolean { return Boolean(this.bound && this.peer && this.channel?.snapshot().connected); }
	get connected(): boolean { return this.ready && this.peerPresent && this.peerReady; }

	// Startup can wait for the supervisor while the worker is still in planning/model recovery.
	async waitReady(timeoutMs = 300_000, { peerOnly = false } = {}): Promise<void> {
		const ready = () => this.connected || (peerOnly && this.peerPresent && this.peerReady);
		if (this.peerFailure) throw new Error(this.peerFailure);
		if (ready()) return;
		await new Promise<void>((resolve, reject) => {
			const finish = (error?: Error) => {
				if (!error && !ready() && !this.stopped) return;
				clearTimeout(timer); this.waiters.delete(finish);
				if (error) reject(error);
				else if (this.stopped) reject(new Error("Session ended while waiting for Intercom readiness."));
				else resolve();
			};
			const timer = setTimeout(() => { this.waiters.delete(finish); reject(new Error("Supervisor did not become ready through pi-intercom; inspect its pane.")); }, timeoutMs);
			this.waiters.add(finish);
			finish();
		});
	}

	view(text: string, reason: string, through?: string, backgroundQuiet = false): View {
		if (!this.bound) throw new Error("No active supervision binding for a worker view.");
		const id = randomUUID();
		const message: Message = { binding: this.binding, role: this.role, kind: "view", id, text: `${text}\n\nworker view id: ${id}`, reason, through, backgroundQuiet };
		this.record("out", message);
		this.latestView = { id, text: message.text!, reason, through, backgroundQuiet };
		if (this.connected) this.publish(message);
		return this.latestView;
	}

	steer(text: string): string {
		if (!this.connected) throw new Error("Worker is disconnected; no instruction was sent.");
		const message: Message = { binding: this.binding, role: this.role, kind: "steer", id: randomUUID(), text };
		this.record("out", message);
		this.pending.set(message.id, message);
		this.publish(message);
		return message.id;
	}

	// The inbox is persisted before handoff. Receipt means Pi started the user message, not model judgment or execution.
	private deliveryText(message: Message): string { return message.kind === "view" ? message.text! : `[supervisor] ${message.text!}`; }
	resumeDelivery(): void {
		if (!this.ctx?.hasPendingMessages?.()) this.delivering = undefined;
		this.idleChecks = 0;
		this.scheduleDelivery(0); // Pi 0.85.1 isIdle includes compaction; check it after the success/failure hook.
	}
	private scheduleDelivery(delay: number): void {
		if (this.deliveryTimer) clearTimeout(this.deliveryTimer);
		this.deliveryTimer = undefined;
		if (!this.bound || !this.inbox.size) return;
		this.deliveryTimer = setTimeout(() => { this.deliveryTimer = undefined; this.deliverNext(); }, delay);
	}
	private deliverNext(): void {
		if (!this.bound || !this.ready || !this.inbox.size) return;
		// Accepted-but-not-yet-presented messages must not be submitted again behind a running turn.
		if (this.ctx?.hasPendingMessages?.()) return;
		if (this.compacting && !this.ctx?.isIdle?.()) {
			if (++this.idleChecks <= 300) this.scheduleDelivery(1000);
			else this.ctx?.ui.notify("Supervision message retained while Pi is busy. Use /goals reconnect when ready to retry delivery.", "warning");
			return;
		}
		if (this.delivering && !this.compacting) return;
		this.compacting = false;
		const message = this.inbox.values().next().value!;
		this.delivering = message.id;
		try {
			if (message.kind === "view") this.onView({ id: message.id, text: message.text!, reason: message.reason!, through: message.through, backgroundQuiet: message.backgroundQuiet === true });
			else this.onSteer(message.text!);
		} catch (error) { this.delivering = undefined; this.ctx?.ui.notify(`Supervision message retained: ${String(error)} Use /goals reconnect to retry.`, "warning"); }
	}

	private record(direction: string, message: Message): void { this.pi.appendEntry(STATE, { direction, message }); }
	private publish(message: Message): void {
		if (this.stopped) throw new Error("Intercom session ended.");
		if (Buffer.byteLength(JSON.stringify(message)) > 16_000) throw new Error("Supervisor message exceeds the Intercom payload limit.");
		if (!this.channel?.snapshot().supported) throw new Error("pi-intercom broker does not support extension channels.");
		this.channel.publish(message, { audience: "capable" });
	}
	private hello(reply = false): void {
		if (!this.stopped && this.binding && this.channel?.snapshot().connected) this.publish({ binding: this.binding, role: this.role, kind: "hello", id: "hello", ready: this.ready, failure: this.failure, reply });
	}
	private receive(event: IntercomExtensionEvent): void {
		if (this.stopped) return;
		if (event.type === "connection") {
			if (!event.connected) {
				if (this.peerReady) this.ctx?.ui.notify("Goal supervision disconnected from pi-intercom.", "warning");
				this.peer = undefined; this.peerReady = false;
			}
			else this.hello();
			if (this.ctx) this.onConnectionChange(this.ctx);
			return;
		}
		if (event.type === "session_left" && event.sessionId === this.peer) {
			this.peer = undefined; this.peerReady = false;
			this.ctx?.ui.notify("Goal supervision peer disconnected; reconnect the existing session.", "warning");
			if (this.ctx) this.onConnectionChange(this.ctx);
			return;
		}
		if (event.type === "session_joined") { this.hello(); return; }
		if (event.type !== "message") return;
		const message = event.payload as Message;
		if (!message || message.binding !== this.binding || message.role !== (this.role === "worker" ? "supervisor" : "worker")) return;
		if (message.kind === "hello") {
			if (this.peer && this.peer !== event.fromSessionId) throw new Error("Two peers claim this supervision binding. Stop the duplicate session.");
			const changed = !this.peer || this.peerReady !== Boolean(message.ready) || this.peerFailure !== message.failure;
			this.peer = event.fromSessionId;
			this.peerReady = Boolean(message.ready);
			this.peerFailure = message.failure;
			if (message.failure) {
				this.ctx?.ui.notify(message.failure, "error");
				for (const wake of this.waiters) wake(new Error(message.failure));
			}
			// Every request gets one reply, even if only the sender forgot its peer.
			// Replies never elicit hellos; own-ready transitions also trigger replay here.
			if (!message.reply) this.hello(true);
			if (this.peerReady && this.ready) {
				if (this.role === "worker" && this.latestView) this.publish({ binding: this.binding, role: this.role, kind: "view", ...this.latestView });
				for (const pending of this.pending.values()) this.publish(pending);
			}
			if (this.connected && this.inbox.size && !this.deliveryTimer) this.scheduleDelivery(0);
			if (changed && this.ctx) this.onConnectionChange(this.ctx);
			for (const wake of this.waiters) wake();
			return;
		}
		if (event.fromSessionId !== this.peer || !this.ready) return;
		if (message.kind === "received") {
			this.pending.delete(message.id);
			const through = message.id === this.latestView?.id ? this.latestView.through : undefined;
			if (through) this.acknowledgedEntry = through;
			this.record("ack", { ...message, through });
			return;
		}
		if (this.received.has(message.id)) {
			if (message.kind === "steer" || (message.kind === "view" && message.reason !== "started")) this.publish({ binding: this.binding, role: this.role, kind: "received", id: message.id });
			return;
		}
		if (message.kind === "view" && this.role === "supervisor") {
			this.latestView = { id: message.id, text: message.text!, reason: message.reason!, through: message.through, backgroundQuiet: message.backgroundQuiet === true };
			if (message.reason === "started") { this.record("in", message); return; }
		} else if (message.kind !== "steer" || this.role !== "worker") return;
		if (this.inbox.has(message.id)) return;
		if (this.inbox.size >= 64) { this.ctx?.ui.notify("Supervision inbox is full; message was not acknowledged. Use /goals reconnect after pending review finishes.", "error"); return; }
		this.record("queued", message);
		this.inbox.set(message.id, message);
		if (this.compacting) this.ctx?.ui.notify("Supervision message retained during compaction; delivery will retry automatically.", "info");
		if (!this.delivering) this.deliverNext();
	}
	private register(): void {
		if (this.stopped || this.registered) return;
		this.pi.events.emit("intercom:extension-register", {
			namespace: "pi-goals", ownerEligible: false,
			onReady: (channel: IntercomExtensionChannel) => { if (this.stopped) return; this.registered = true; this.channel = channel; this.hello(); },
			onEvent: (event: IntercomExtensionEvent) => {
				try { this.receive(event); }
				catch (error) { if (!this.stopped) this.ctx?.ui.notify(`Goal Intercom error: ${String(error)}`, "error"); }
			},
		});
	}
	private async loadIntercom(event: SessionStartEvent, ctx: ExtensionContext): Promise<void> {
		if (this.pi.getAllTools().some(tool => tool.name === "intercom")) throw new Error("Installed pi-intercom has no extension channel; update it before continuing.");
		const starts: Array<(event: SessionStartEvent, ctx: ExtensionContext) => unknown> = [];
		const api = { ...this.pi, on: (name: string, handler: (...args: any[]) => any) => {
			if (name === "session_start") starts.push(handler);
			else this.pi.on(name as Parameters<ExtensionAPI["on"]>[0], handler);
		} } as ExtensionAPI;
		const { default: intercom } = await import("pi-intercom");
		intercom(api);
		for (const start of starts) await start(event, ctx);
		this.register();
	}
}
