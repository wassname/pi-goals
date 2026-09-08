import { randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionContext, SessionStartEvent } from "@earendil-works/pi-coding-agent";
import type { IntercomExtensionChannel, IntercomExtensionEvent } from "pi-intercom/extension-api.ts";

export type Role = "worker" | "supervisor";
export interface View { id: string; text: string; reason: string; through?: string; backgroundQuiet: boolean }
interface Message { binding: string; role: Role; kind: "hello" | "view" | "steer" | "received"; id: string; text?: string; reason?: string; ready?: boolean; through?: string; backgroundQuiet?: boolean }
const STATE = "pi-goals-intercom";

export class GoalIntercom {
	private channel?: IntercomExtensionChannel;
	private ctx?: ExtensionContext;
	private stopped = false;
	private registered = false;
	private binding = "";
	private role: Role = "worker";
	private ready = false;
	private peer?: string;
	private peerReady = false;
	private pending = new Map<string, Message>();
	private received = new Set<string>();
	private waiters = new Set<() => void>();
	latestView?: View;
	acknowledgedEntry?: string;
	onView: (view: View) => void = () => {};
	onSteer: (text: string) => void = () => {};

	constructor(private pi: ExtensionAPI) {
		pi.events.on("intercom:extension-registry-ready", () => this.register());
		this.register();
		pi.on("session_start", async (event, ctx) => {
			this.ctx = ctx;
			if (!this.channel) await this.loadIntercom(event, ctx);
		});
		pi.on("session_shutdown", async () => {
			this.stopped = true;
			this.peerReady = false;
			for (const wake of this.waiters) wake();
		});
	}

	configure(binding: string, role: Role, ctx: ExtensionContext): void {
		this.binding = binding;
		this.role = role;
		this.ctx = ctx;
		this.ready = role === "worker";
		this.peer = undefined;
		this.peerReady = false;
		this.pending.clear();
		this.received.clear();
		this.latestView = undefined;
		this.acknowledgedEntry = undefined;
		for (const entry of ctx.sessionManager.getEntries()) {
			if (entry.type !== "custom" || entry.customType !== STATE) continue;
			const record = entry.data as { direction: string; message: Message };
			const message = record.message;
			if (message.binding !== binding) continue;
			if (record.direction === "out" && message.kind === "steer") this.pending.set(message.id, message);
			if (record.direction === "ack") {
				this.pending.delete(message.id);
				if (message.through) this.acknowledgedEntry = message.through;
			}
			if (record.direction === "in") this.received.add(message.id);
			if (message.kind === "view") this.latestView = { id: message.id, text: message.text!, reason: message.reason!, through: message.through, backgroundQuiet: message.backgroundQuiet === true };
		}
		this.hello();
	}

	markReady(): void { if (!this.stopped) { this.ready = true; this.hello(); } }
	get ended(): boolean { return this.stopped; }
	get connected(): boolean { return Boolean(this.channel?.snapshot().connected && this.peerReady); }

	async waitReady(timeoutMs = 300_000): Promise<void> {
		if (this.connected) return;
		await new Promise<void>((resolve, reject) => {
			const finish = () => {
				if (!this.connected && !this.stopped) return;
				clearTimeout(timer); this.waiters.delete(finish);
				if (this.stopped) reject(new Error("Session ended while waiting for Intercom readiness."));
				else resolve();
			};
			const timer = setTimeout(() => { this.waiters.delete(finish); reject(new Error("Supervisor did not become ready through pi-intercom; inspect its pane.")); }, timeoutMs);
			this.waiters.add(finish);
			finish();
		});
	}

	view(text: string, reason: string, through?: string, backgroundQuiet = false): View {
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

	private record(direction: string, message: Message): void { this.pi.appendEntry(STATE, { direction, message }); }
	private publish(message: Message): void {
		if (this.stopped) throw new Error("Intercom session ended.");
		if (Buffer.byteLength(JSON.stringify(message)) > 16_000) throw new Error("Supervisor message exceeds the Intercom payload limit.");
		if (!this.channel?.snapshot().supported) throw new Error("pi-intercom broker does not support extension channels.");
		this.channel.publish(message, { audience: "capable" });
	}
	private hello(): void {
		if (!this.stopped && this.binding && this.channel?.snapshot().connected) this.publish({ binding: this.binding, role: this.role, kind: "hello", id: "hello", ready: this.ready });
	}
	private receive(event: IntercomExtensionEvent): void {
		if (this.stopped) return;
		if (event.type === "connection") {
			if (!event.connected) {
				if (this.peerReady) this.ctx?.ui.notify("Goal supervision disconnected from pi-intercom.", "warning");
				this.peer = undefined; this.peerReady = false;
			}
			else this.hello();
			return;
		}
		if (event.type === "session_left" && event.sessionId === this.peer) {
			this.peer = undefined; this.peerReady = false;
			this.ctx?.ui.notify("Goal supervision peer disconnected; reconnect the existing session.", "warning");
			return;
		}
		if (event.type === "session_joined") { this.hello(); return; }
		if (event.type !== "message") return;
		const message = event.payload as Message;
		if (!message || message.binding !== this.binding || message.role !== (this.role === "worker" ? "supervisor" : "worker")) return;
		if (message.kind === "hello") {
			if (this.peer && this.peer !== event.fromSessionId) throw new Error("Two peers claim this supervision binding. Stop the duplicate session.");
			const changed = !this.peer || this.peerReady !== Boolean(message.ready);
			this.peer = event.fromSessionId;
			this.peerReady = Boolean(message.ready);
			if (changed) {
				this.hello();
				if (this.peerReady) {
					if (this.role === "worker" && this.latestView) this.publish({ binding: this.binding, role: this.role, kind: "view", ...this.latestView });
					for (const pending of this.pending.values()) this.publish(pending);
				}
			}
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
			if (message.reason !== "started") {
				this.onView(this.latestView);
				this.publish({ binding: this.binding, role: this.role, kind: "received", id: message.id });
			}
		} else if (message.kind === "steer" && this.role === "worker") {
			this.onSteer(message.text!);
			this.received.add(message.id);
			this.record("in", message);
			this.publish({ binding: this.binding, role: this.role, kind: "received", id: message.id });
			return;
		} else return;
		this.received.add(message.id);
		this.record("in", message);
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
