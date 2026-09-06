import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

const REGISTER_EVENT = "pi-subagents:runtime-agent-register:v1";
const RPC_REQUEST_EVENT = "subagents:rpc:v1:request";
const RPC_REPLY_PREFIX = "subagents:rpc:v1:reply:";
const RPC_VERSION = 1;
const RPC_TIMEOUT_MS = 15_000;
export const SUPERVISOR_AGENT = "goal-supervisor";

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
Your forked planning history is compacted before your first turn. Launch one goal-worker, then call bg_wait with its run ID
so this supervisory turn stays alive until the worker completes or needs attention. Do not poll status or repeatedly steer
an active worker. Use CheckWorkerState once only after a needs-attention notice or a scheduled review. If a terminal worker
needs a correction, launch one replacement goal-worker instead of resuming its old run ID. Read the current plan, repository,
cited evidence, and saved verification output yourself after the worker finishes. Do not edit project files. Use read/search
and standard verification commands only. The worker must commit its changes before approval. When no nested work is active,
HEAD is committed, the worktree is clean, and the evidence proves the discriminator, call ApproveGoal with the current
approval ID. Otherwise give the retained worker one concrete correction. Only ApproveGoal creates acceptance. -- Pi/Codex`;

export function registerGoalSupervisor(events: EventBus, model: string | null): Registration {
	const supervisorRuntime = fileURLToPath(new URL("./supervisor-runtime.ts", import.meta.url));
	const request: Record<string, unknown> = {
		version: 1,
		name: SUPERVISOR_AGENT,
		definition: {
			description: "Read-only supervisor that owns a nested retained implementation worker.",
			systemPrompt: supervisorSystemPrompt,
			tools: ["read", "grep", "find", "ls", "bash", "subagent", "bg_wait", "CheckWorkerState", "ApproveGoal"],
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
		},
	};
	events.emit(REGISTER_EVENT, request);
	const result = request.result as { ok?: boolean; registration?: Registration; error?: Error } | undefined;
	if (!result) throw new Error("pi-subagents is not installed or not ready.");
	if (!result.ok || !result.registration) throw result.error ?? new Error("pi-subagents rejected the goal-supervisor agent.");
	return result.registration;
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

export async function startGoalSupervisor(events: EventBus, cwd: string, task: string, compactPlanning: boolean, signal?: AbortSignal): Promise<string> {
	const data = await rpc(events, "spawn", {
		agent: SUPERVISOR_AGENT,
		task,
		cwd,
		context: "fork",
		async: true,
		mission: false,
		extensionBindings: { "pi-goals/1": { compactPlanning } },
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

function findNode(nodes: AsyncNode[], runId: string): AsyncNode | undefined {
	for (const node of nodes) {
		if (node.id === runId) return node;
		const child = node.children && findNode(node.children, runId);
		if (child) return child;
	}
	return undefined;
}

async function asyncSnapshot(events: EventBus): Promise<AsyncSnapshot | undefined> {
	return (await rpc(events, "status", {})).asyncSnapshot;
}

export async function subagentWorkState(events: EventBus): Promise<WorkState> {
	const snapshot = await asyncSnapshot(events);
	if (!validSnapshot(snapshot)) return "unknown";
	return snapshot.runs.some(activeNode) ? "active" : "idle";
}

export async function retainedRunState(events: EventBus, runId: string): Promise<WorkState> {
	const snapshot = await asyncSnapshot(events);
	if (!validSnapshot(snapshot)) return "unknown";
	const node = findNode(snapshot.runs, runId);
	return node && activeNode(node) ? "active" : "idle";
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
