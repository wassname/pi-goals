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

export const supervisorSystemPrompt = `You are the retained goal supervisor. The main Pi session is a thin human-facing coordinator.
You own the current plan review and the retained implementation worker. At every review, reread the full
current plan named in your task, identify the exact goal block, inspect the repository, cited artifacts, and
saved verification output, then launch, resume, or steer the nested goal-worker as needed. Do not edit project
files. Use read/search and standard verification commands only. The worker is the sole implementation writer and
must commit its changes before you consider approval. When no nested work is active, HEAD is committed, the worktree
is clean, and you have explicitly inspected the plan, repository, evidence, and verification output, call ApproveGoal.
Otherwise return continue or redirect the worker. Do not claim acceptance in prose: only ApproveGoal creates the durable
approval checkpoint. -- Pi/Codex`;

export function registerGoalSupervisor(events: EventBus, model: string | null): Registration {
	const supervisorRuntime = fileURLToPath(new URL("./supervisor-runtime.ts", import.meta.url));
	const request: Record<string, unknown> = {
		version: 1,
		name: SUPERVISOR_AGENT,
		definition: {
			description: "Read-only supervisor that owns a nested retained implementation worker.",
			systemPrompt: supervisorSystemPrompt,
			allowNestedSubagents: true,
			subagentOnlyExtensions: [supervisorRuntime],
			...(model ? { model } : {}),
			systemPromptMode: "replace",
			inheritProjectContext: true,
			inheritGlobalContext: true,
			inheritSkills: true,
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

async function rpc(events: EventBus, method: "spawn" | "resume" | "steer" | "status", params: Record<string, unknown>, signal?: AbortSignal): Promise<RpcData> {
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

export async function startGoalSupervisor(events: EventBus, cwd: string, task: string, signal?: AbortSignal): Promise<string> {
	const data = await rpc(events, "spawn", {
		agent: SUPERVISOR_AGENT,
		task,
		cwd,
		context: "fork",
		async: true,
		mission: false,
	}, signal);
	return asyncRunId(data);
}

export async function resumeGoalSupervisor(events: EventBus, runId: string, task: string, signal?: AbortSignal): Promise<string> {
	return asyncRunId(await rpc(events, "resume", { id: runId, message: task }, signal));
}

export async function steerGoalSupervisor(events: EventBus, runId: string, task: string, signal?: AbortSignal): Promise<void> {
	await rpc(events, "steer", { id: runId, message: task, mode: "steer" }, signal);
}

function activeNode(node: AsyncNode): boolean {
	return node.state === "queued" || node.state === "running" || Boolean(node.children?.some(activeNode));
}

export async function subagentWorkState(events: EventBus): Promise<WorkState> {
	const snapshot = (await rpc(events, "status", {})).asyncSnapshot;
	if (snapshot?.kind !== "pi-subagents.async-status-snapshot" || snapshot.version !== 1) return "unknown";
	if (snapshot.omitted.runs > 0 || snapshot.omitted.children > 0 || snapshot.omitted.byteLimitExceeded) return "unknown";
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
	if (!replied) return "unknown";
	return processes.some((process) => process.status === "running" || process.status === "terminating" || process.status === "terminate_timeout") ? "active" : "idle";
}
