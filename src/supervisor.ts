import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { type ExtensionAPI, type ExtensionContext, getAgentDir, SessionManager } from "@earendil-works/pi-coding-agent";

export const SUPERVISOR_ROLE = "pi-goals-supervisor";
export interface SupervisorBinding {
	id: string;
	planPath: string;
	workerSession: string;
	workerPane: string;
	supervisorPane?: string;
	supervisorSession?: string;
	active?: boolean;
	stopped?: boolean;
	/** User pause: retain the pair, but no autonomous work until explicit resume. */
	paused?: boolean;
	pauseId?: string;
	everyTurns: number;
	intervalMs: number;
	compactTokens: number;
}
export interface Bootstrap { binding: SupervisorBinding; workerId: string }
export interface SupervisorStatus { connected: boolean; binding?: SupervisorBinding; workerId: string; role?: string; activity?: string; lastFailure?: string }
export interface SupervisorDecision { bindingId: string; goal: string; planHash: string; decision: "approve" | "needs_work" | "needs_user"; reason: string }

export function planHash(text: string): string {
	return createHash("sha256").update(text).digest("hex");
}

export interface SupervisorController {
 status(signal?: AbortSignal): Promise<SupervisorStatus>;
 prepare(binding: SupervisorBinding, signal?: AbortSignal): Promise<void>;
 bootstrap(bootstrap: Bootstrap, signal?: AbortSignal): Promise<SupervisorBinding>;
 attached(bindingId: string, signal?: AbortSignal): Promise<SupervisorBinding>;
 activate(bindingId: string, signal?: AbortSignal): Promise<void>;
 review(bindingId: string, goal: string, hash: string, signal?: AbortSignal): Promise<SupervisorDecision>;
 stop(bindingId: string): Promise<void>;
 pause(exit?: boolean): void;
 reconnect(signal?: AbortSignal): Promise<void>;
 resume(bindingId: string, hash: string, signal?: AbortSignal): Promise<void>;
}

export function validBinding(value: unknown): value is SupervisorBinding {
  if (!value || typeof value !== "object") return false;
  const b = value as SupervisorBinding;
  return [b.id, b.planPath, b.workerSession, b.workerPane].every(v => typeof v === "string" && v.length > 0)
    && [b.everyTurns, b.intervalMs, b.compactTokens].every(v => Number.isSafeInteger(v) && v > 0);
}
export function planText(binding: SupervisorBinding): string {
  return readFileSync(binding.planPath, "utf8");
}
/** Startup waits may have a deadline. Model checkpoints pass null: elapsed thinking is not failure. */
export function pendingReply<T>(signal: AbortSignal | undefined, cancel: () => void, timeoutMs: number | null = 600_000) {
  let finish!: (value?: T, error?: Error) => void;
  const promise = new Promise<T>((resolve, reject) => {
    let settled = false;
    const abort = () => finish(undefined, new Error("Supervisor request cancelled"));
    const timer = timeoutMs === null ? undefined : setTimeout(() => finish(undefined, new Error("Supervisor request timed out; retry or turn the steward off")), timeoutMs);
    finish = (value, error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      if (error) {
        // Local cancellation must settle even if notifying a disconnected peer throws.
        try { cancel(); } catch { /* The caller reports the request failure; remote state is unconfirmed. */ }
        reject(error);
      } else resolve(value as T);
    };
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) queueMicrotask(abort);
  });
  return { requestId: randomUUID(), promise, finish };
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

export function initializeSupervisor(supervisor: SupervisorController, ctx: ExtensionContext, bootstrap: Bootstrap, signal?: AbortSignal): void {
	// Let all packages initialize before bootstrapping the local supervisor role.
	setImmediate(() => {
		if (signal?.aborted) return;
		void supervisor.bootstrap(bootstrap, signal).catch((error: Error) => {
			if (!signal?.aborted) ctx.ui.notify(`Supervisor initialization failed: ${error.message}`, "error");
		});
	});
}

/** Replay only the worker's explicit resource choices, never its prompt, mode, model or credentials.
 * Configured packages come from the same agent directory. No companion extension is added. */
export function supervisorResourceArgs(argv: string[]): string[] {
  const valued = new Set(["-e", "--extension", "--skill", "--prompt-template", "--theme"]);
  const flags = new Set(["--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files", "-nc", "--approve", "-a", "--no-approve", "-na"]);
  const aliases: Record<string, string> = { "-ne": "--no-extensions", "-ns": "--no-skills", "-np": "--no-prompt-templates" };
  const result: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = aliases[argv[i]] ?? argv[i];
    if (arg === "--") break;
    if (valued.has(arg) && argv[i + 1]) result.push(arg, argv[++i]);
    else if (flags.has(arg)) result.push(arg);
  }
  return result;
}

export async function startSupervisor(
	pi: ExtensionAPI, supervisor: SupervisorController, ctx: ExtensionContext, planPath: string, existing: SupervisorBinding | null,
	save: (binding: SupervisorBinding) => void, signal: AbortSignal,
): Promise<SupervisorBinding> {
	if (process.env.HERDR_ENV !== "1" || !process.env.HERDR_PANE_ID) throw new Error("Start Pi inside Herdr before enabling the steward at Ready.");
	const status = await supervisor.status(signal);
	signal.throwIfAborted();
	if (existing && status.connected && status.binding?.id === existing.id) return status.binding;
	if ((!existing && status.role && status.role !== "none") || (status.binding && status.binding.id !== existing?.id)) throw new Error("This session already has another supervision relationship. Stop it explicitly before Ready.");
	const parent = ctx.sessionManager.getSessionFile();
	const leaf = ctx.sessionManager.getLeafId();
	if (!parent || !leaf) throw new Error("The planning session must be persisted before creating its supervisor fork.");
	let binding = existing ?? {
		id: randomUUID(), planPath, workerSession: parent, workerPane: process.env.HERDR_PANE_ID,
		everyTurns: 50, intervalMs: 60 * 60_000, compactTokens: 100_000,
	};
	if (!existing) {
		save(binding);
		await supervisor.prepare(binding, signal);
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
		return await supervisor.attached(binding.id, signal);
	}
	const split = await herdr(pi, ["pane", "split", "--current", "--direction", "right", "--cwd", ctx.cwd, "--env", `PI_CODING_AGENT_DIR=${getAgentDir()}`, "--no-focus"], signal);
	const pane = split.pane?.pane_id;
	if (typeof pane !== "string") throw new Error("Herdr split did not return a pane ID");
	binding = { ...binding, supervisorPane: pane };
	save(binding);
	signal.throwIfAborted();
	// Keep bootstrap and worker binding identical, including the returned pane identity.
	SessionManager.open(binding.supervisorSession!).appendCustomEntry(SUPERVISOR_ROLE, { binding, workerId: status.workerId });
	const waiting = supervisor.attached(binding.id, signal);
	void waiting.catch(() => {});
	try {
		await herdr(pi, ["agent", "start", `supervisor-${binding.id.slice(0, 8)}`, "--kind", "pi", "--pane", pane, "--", "--session", binding.supervisorSession!, ...supervisorResourceArgs(process.argv.slice(2))], signal);
		return await waiting;
	} catch (error) {
		throw new Error(`Supervisor startup incomplete: ${String(error)}. Inspect the recorded pane, resolve startup, reload it, then retry Ready.`);
	}
}
