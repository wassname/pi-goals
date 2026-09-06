import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

const REGISTER_EVENT = "pi-subagents:runtime-agent-register:v1";
const RPC_REQUEST_EVENT = "subagents:rpc:v1:request";
const RPC_REPLY_PREFIX = "subagents:rpc:v1:reply:";
const RPC_VERSION = 1;
const RPC_TIMEOUT_MS = 15_000;
export const SUPERVISOR_AGENT = "goal-supervisor";
export const GOAL_WORKER_AGENT = "pi-goals-worker-v1";

interface EventBus {
	on(event: string, handler: (data: unknown) => void): () => void;
	emit(event: string, data: unknown): void;
}

interface Registration {
	dispose(): void;
}

interface RpcData {
	text: string;
	details?: Record<string, unknown>;
	asyncSnapshot?: AsyncSnapshot;
}

interface AsyncNode {
	id: string;
	state: string;
	children?: AsyncNode[];
}

interface AsyncSnapshot {
	kind: string;
	version: number;
	omitted: { runs: number; children: number; byteLimitExceeded: boolean };
	runs: AsyncNode[];
}

export type WorkState = "active" | "idle" | "unknown";

export const supervisorSystemPrompt = `You are the retained goal supervisor. The main Pi session only coordinates with the human.
Your forked planning history may be compacted before your first turn. Launch ${GOAL_WORKER_AGENT} in the foreground with exactly
agent, task, async:false, context:"fork", and, when named in the current direction, that worker model. Wait for its result; do not use
bg_wait or worker run IDs. Read the current plan, repository, cited evidence, and saved verification output yourself after the
worker finishes. Do not edit project files. Use read/search and standard verification commands only. The worker must commit its
changes before approval. If the evidence needs a correction, launch a new foreground ${GOAL_WORKER_AGENT} with one concrete task
and wait for it. On a later turn, when HEAD is committed, the worktree is clean, and the evidence proves the discriminator, call
ApproveGoal with the current approval ID. Only ApproveGoal creates acceptance. -- Pi/Codex`;

function registerRuntimeAgent(events: EventBus, name: string, definition: Record<string, unknown>): Registration {
	const request: Record<string, unknown> = { version: 1, name, definition };
	events.emit(REGISTER_EVENT, request);
	const result = request.result as { ok?: boolean; registration?: Registration; error?: Error } | undefined;
	if (!result) throw new Error("pi-subagents is not installed or not ready.");
	if (!result.ok || !result.registration) throw result.error ?? new Error(`pi-subagents rejected the ${name} agent.`);
	return result.registration;
}

export function registerGoalSupervisor(events: EventBus, model: string | null): Registration {
	const supervisorRuntime = fileURLToPath(new URL("./supervisor-runtime.ts", import.meta.url));
	return registerRuntimeAgent(events, SUPERVISOR_AGENT, {
		description: "Read-only supervisor that owns a foreground implementation worker.",
		systemPrompt: supervisorSystemPrompt,
		tools: ["read", "grep", "find", "ls", "bash", "subagent", "ApproveGoal"],
		allowNestedSubagents: true,
		subagentOnlyExtensions: [supervisorRuntime],
		...(model ? { model } : {}),
		systemPromptMode: "replace",
		thinking: "low",
		inheritProjectContext: false,
		inheritGlobalContext: false,
		inheritSkills: false,
		defaultContext: "fork",
		defaultAsync: true,
		defaultProgress: true,
	});
}

async function rpc(events: EventBus, method: "spawn" | "resume" | "steer" | "status" | "stop", params: Record<string, unknown>, signal?: AbortSignal): Promise<RpcData> {
	if (signal?.aborted) throw new Error("Goal-worker request aborted.");
	const requestId = randomUUID();
	return new Promise((resolve, reject) => {
		let timer: ReturnType<typeof setTimeout>;
		const replyEvent = `${RPC_REPLY_PREFIX}${requestId}`;
		const cleanup = () => {
			clearTimeout(timer);
			unsubscribe();
			signal?.removeEventListener("abort", onAbort);
		};
		const onAbort = () => {
			cleanup();
			reject(new Error("Goal-worker request aborted."));
		};
		const unsubscribe = events.on(replyEvent, (raw) => {
			const reply = raw as { success?: boolean; data?: RpcData; error?: { message?: string } };
			cleanup();
			if (!reply.success || !reply.data) reject(new Error(reply.error?.message ?? `pi-subagents ${method} failed.`));
			else resolve(reply.data);
		});
		timer = setTimeout(() => {
			cleanup();
			reject(new Error(`pi-subagents ${method} did not reply within ${RPC_TIMEOUT_MS / 1000}s.`));
		}, RPC_TIMEOUT_MS);
		timer.unref();
		signal?.addEventListener("abort", onAbort, { once: true });
		events.emit(RPC_REQUEST_EVENT, { version: RPC_VERSION, requestId, method, params, source: { extension: "pi-goals" } });
	});
}

function asyncRunId(data: RpcData): string {
	const runId = data.details?.asyncId ?? data.details?.runId;
	if (typeof runId !== "string" || !runId) throw new Error("pi-subagents returned no async run ID.");
	return runId;
}

export async function startGoalSupervisor(events: EventBus, cwd: string, task: string, compactPlanning: boolean, workerModel: string | null, signal?: AbortSignal): Promise<string> {
	const data = await rpc(events, "spawn", {
		agent: SUPERVISOR_AGENT,
		task,
		cwd,
		context: "fork",
		async: true,
		mission: false,
		extensionBindings: { "pi-goals/1": { compactPlanning, workerModel } },
	}, signal);
	return asyncRunId(data);
}

export async function resumeGoalSupervisor(events: EventBus, runId: string, task: string, signal?: AbortSignal): Promise<string> {
	return asyncRunId(await rpc(events, "resume", { id: runId, message: task }, signal));
}

export async function steerGoalSupervisor(events: EventBus, runId: string, task: string, signal?: AbortSignal): Promise<void> {
	await rpc(events, "steer", { id: runId, message: task, mode: "steer" }, signal);
}

export async function stopGoalSupervisor(events: EventBus, runId: string): Promise<void> {
	try {
		await rpc(events, "stop", { id: runId });
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if (!/not found|already completed|\bis (?:complete|completed|failed|partial|paused|stopped|rejected)\b/i.test(message)) throw error;
	}
}

export function terminalSteerError(error: unknown): boolean {
	const message = error instanceof Error ? error.message : String(error);
	return /not found|already completed|not running|\bis (?:complete|completed|failed|partial|paused|stopped|rejected)\b/i.test(message);
}

function activeNode(node: AsyncNode): boolean {
	return node.state === "queued" || node.state === "running" || node.state === "stopping" || Boolean(node.children?.some(activeNode));
}

function validSnapshot(snapshot: AsyncSnapshot | undefined): snapshot is AsyncSnapshot {
	return snapshot?.kind === "pi-subagents.async-status-snapshot" && snapshot.version === 1 && snapshot.omitted.runs === 0 && snapshot.omitted.children === 0 && !snapshot.omitted.byteLimitExceeded;
}

async function asyncSnapshot(events: EventBus): Promise<AsyncSnapshot | undefined> {
	return (await rpc(events, "status", {})).asyncSnapshot;
}

export async function subagentWorkState(events: EventBus): Promise<WorkState> {
	const snapshot = await asyncSnapshot(events);
	if (!validSnapshot(snapshot)) return "unknown";
	return snapshot.runs.some(activeNode) ? "active" : "idle";
}

export interface ProcessInfo {
	status: string;
}

export function processWorkState(events: EventBus): WorkState {
	let replied = false;
	let processes: ProcessInfo[] = [];
	events.emit("processes:request:list", {
		reply(value: ProcessInfo[]) {
			replied = true;
			processes = value;
		},
	});
	if (!replied || !Array.isArray(processes)) return "unknown";
	const terminal = new Set(["finished", "failed", "exited", "killed"]);
	return processes.every((process) => terminal.has(process.status)) ? "idle" : "active";
}
