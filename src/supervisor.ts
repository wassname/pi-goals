import { createHash, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { type ExtensionAPI, type ExtensionContext, SessionManager } from "@earendil-works/pi-coding-agent";

export const SUPERVISOR_ROLE = "pi-goals-supervisor";
const PLAN_API = "pi-supervise:plan:v1";
export interface SupervisorBinding {
	id: string;
	planPath: string;
	workerSession: string;
	workerPane: string;
	supervisorPane?: string;
	supervisorSession?: string;
	active?: boolean;
	everyTurns: number;
	intervalMs: number;
	compactTokens: number;
}
interface Bootstrap { binding: SupervisorBinding; workerId: string }
interface SupervisorStatus { connected: boolean; binding?: SupervisorBinding; workerId: string; role?: string }
export interface SupervisorDecision { bindingId: string; goal: string; planHash: string; decision: "approve" | "needs_work" | "needs_user"; reason: string }

export function planHash(text: string): string {
	return createHash("sha256").update(text).digest("hex");
}

/** The owner claims synchronously; its promise includes peer acknowledgement or review. */
export function supervisorRequest<T>(pi: ExtensionAPI, method: string, params: Record<string, unknown> = {}, signal?: AbortSignal): Promise<T> {
	return new Promise((resolve, reject) => {
		const request = { version: 1, method, ...params, signal, handled: false, resolve, reject };
		pi.events.emit(PLAN_API, request);
		if (!request.handled) reject(new Error("Load the plan-aware pi-intercom-supervisor and pi-intercom packages in both sessions, then reload Pi."));
	});
}

async function herdr(pi: ExtensionAPI, args: string[], signal?: AbortSignal): Promise<Record<string, any>> {
	if (process.env.HERDR_ENV !== "1") throw new Error("Start Pi inside Herdr to launch or focus the supervisor. No pane was created.");
	const result = await pi.exec("herdr", args, { timeout: 45_000, signal });
	if (result.code !== 0) throw new Error(`Herdr: ${result.stderr || result.stdout}`);
	const parsed = JSON.parse(result.stdout);
	if (parsed.error) throw new Error(`Herdr: ${parsed.error.message}`);
	return parsed.result ?? parsed;
}

export async function focusSupervisor(pi: ExtensionAPI, binding: SupervisorBinding, target: "supervisor" | "worker" | "zoom"): Promise<void> {
	const pane = target === "worker" ? binding.workerPane : binding.supervisorPane;
	if (!pane) throw new Error("No supervisor pane is recorded. Select Ready to start it.");
	try { await herdr(pi, target === "zoom" ? ["pane", "zoom", "--pane", pane, "--toggle"] : ["agent", "focus", pane]); }
	catch (error) { throw new Error(`${String(error)}. Session location/liveness is unknown. Locate the existing supervisor first; only after confirming it is no longer running, reopen pi --session ${JSON.stringify(binding.supervisorSession)}.`); }
}

export function supervisorBootstrap(ctx: ExtensionContext): Bootstrap | undefined {
	const entry = ctx.sessionManager.getBranch().filter(e => e.type === "custom" && e.customType === SUPERVISOR_ROLE).at(-1);
	return entry?.type === "custom" ? entry.data as Bootstrap : undefined;
}

export function initializeSupervisor(pi: ExtensionAPI, ctx: ExtensionContext, bootstrap: Bootstrap, signal?: AbortSignal): void {
	// session_start handlers are ordered. Let all packages initialize before requesting their API.
	setImmediate(() => {
		if (signal?.aborted) return;
		void supervisorRequest(pi, "bootstrap", bootstrap as unknown as Record<string, unknown>, signal).catch((error: Error) => {
			if (!signal?.aborted) ctx.ui.notify(`Supervisor initialization failed: ${error.message}`, "error");
		});
	});
}

export async function startSupervisor(
	pi: ExtensionAPI, ctx: ExtensionContext, planPath: string, existing: SupervisorBinding | null,
	save: (binding: SupervisorBinding) => void, signal: AbortSignal,
): Promise<SupervisorBinding> {
	if (process.env.HERDR_ENV !== "1" || !process.env.HERDR_PANE_ID) throw new Error("Start Pi inside Herdr before enabling the steward at Ready.");
	const status = await supervisorRequest<SupervisorStatus>(pi, "status", {}, signal);
	signal.throwIfAborted();
	if (existing && status.connected && status.binding?.id === existing.id) return status.binding;
	if ((!existing && status.role && status.role !== "none") || (status.binding && status.binding.id !== existing?.id)) throw new Error("This session already has another supervision relationship. Stop it explicitly before Ready.");
	const parent = ctx.sessionManager.getSessionFile();
	const leaf = ctx.sessionManager.getLeafId();
	if (!parent || !leaf) throw new Error("The planning session must be persisted before creating its supervisor fork.");
	const supervisorSource = pi.getCommands().find(command => command.name === "supervise")?.sourceInfo?.path;
	const intercomSource = pi.getAllTools().find(tool => tool.name === "intercom")?.sourceInfo?.path;
	if (!supervisorSource || !intercomSource) throw new Error("Cannot resolve the loaded supervisor and Intercom extensions; load both before Ready.");
	let binding = existing ?? {
		id: randomUUID(), planPath, workerSession: parent, workerPane: process.env.HERDR_PANE_ID,
		everyTurns: 50, intervalMs: 60 * 60_000, compactTokens: 100_000,
	};
	if (!existing) {
		save(binding);
		await supervisorRequest(pi, "prepare", { binding }, signal);
		signal.throwIfAborted();
	}
	if (!binding.supervisorSession) {
		const fork = SessionManager.open(parent);
		const sessionFile = fork.createBranchedSession(leaf);
		if (!sessionFile) throw new Error("Could not persist the supervisor fork");
		binding = { ...binding, supervisorSession: sessionFile };
		fork.appendCustomEntry(SUPERVISOR_ROLE, { binding, workerId: status.workerId });
		fork.appendSessionInfo(`Supervisor ${binding.id.slice(0, 8)}`);
		save(binding);
	}
	if (binding.supervisorPane) {
		// An existing occupant is not permission to start another process on the same session file.
		await focusSupervisor(pi, binding, "supervisor");
		signal.throwIfAborted();
		return await supervisorRequest<SupervisorBinding>(pi, "attached", { bindingId: binding.id }, signal);
	}
	const split = await herdr(pi, ["pane", "split", "--current", "--direction", "right", "--cwd", ctx.cwd, "--no-focus"], signal);
	const pane = split.pane?.pane_id;
	if (typeof pane !== "string") throw new Error("Herdr split did not return a pane ID");
	binding = { ...binding, supervisorPane: pane };
	save(binding);
	signal.throwIfAborted();
	// Keep bootstrap and worker binding identical, including the returned pane identity.
	SessionManager.open(binding.supervisorSession!).appendCustomEntry(SUPERVISOR_ROLE, { binding, workerId: status.workerId });
	const waiting = supervisorRequest<SupervisorBinding>(pi, "attached", { bindingId: binding.id }, signal);
	void waiting.catch(() => {});
	try {
		await herdr(pi, ["agent", "start", `supervisor-${binding.id.slice(0, 8)}`, "--kind", "pi", "--pane", pane, "--", "--session", binding.supervisorSession!,
			"-e", supervisorSource, "-e", intercomSource, "-e", fileURLToPath(new URL(import.meta.url.endsWith(".ts") ? "./index.ts" : "./index.js", import.meta.url))], signal);
		return await waiting;
	} catch (error) {
		throw new Error(`Supervisor startup incomplete: ${String(error)}. Inspect the recorded pane, resolve startup, reload it, then retry Ready.`);
	}
}
