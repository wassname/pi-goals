import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

const REGISTER_EVENT = "pi-subagents:runtime-agent-register:v1";
const RPC_REQUEST_EVENT = "subagents:rpc:v1:request";
const RPC_REPLY_PREFIX = "subagents:rpc:v1:reply:";
const RPC_VERSION = 1;
const RPC_TIMEOUT_MS = 15_000;
export const WORKER_AGENT = "goal-worker";

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

export const workerSystemPrompt = `You are the implementation worker for one supervised Pi session.
Work autonomously from the approved plan. Keep the plan current, run the real checks, and leave
specific evidence in its Log. The human's latest message outranks the plan; update affected goals
instead of defending an obsolete decision. The main Pi agent is the research supervisor and owns
direction and goal sign-off. Send contact_supervisor progress updates when evidence changes the research direction,
when an hourly check asks for one, or when you need a decision. Do not claim a goal is complete;
report the evidence and let the supervisor decide. Continue until the plan is complete or the human
stops the session. -- Pi/Codex`;

export function registerGoalWorker(events: EventBus, model: string | null): Registration {
	const runtimeExtension = fileURLToPath(new URL("./worker-runtime.ts", import.meta.url));
	const piVccExtension = fileURLToPath(import.meta.resolve("@sting8k/pi-vcc"));
	const request: Record<string, unknown> = {
		version: 1,
		name: WORKER_AGENT,
		definition: {
			description: "Implementation worker directed by the main goal supervisor.",
			systemPrompt: workerSystemPrompt,
			allowNestedSubagents: true,
			subagentOnlyExtensions: [piVccExtension, runtimeExtension],
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
	if (!result.ok || !result.registration) throw result.error ?? new Error("pi-subagents rejected the goal-worker agent.");
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

export async function startGoalWorker(events: EventBus, cwd: string, task: string, signal?: AbortSignal): Promise<string> {
	const data = await rpc(events, "spawn", {
		agent: WORKER_AGENT,
		task,
		cwd,
		context: "fork",
		async: true,
		mission: false,
	}, signal);
	return asyncRunId(data);
}

export async function resumeGoalWorker(events: EventBus, runId: string, task: string, signal?: AbortSignal): Promise<string> {
	return asyncRunId(await rpc(events, "resume", { id: runId, message: task }, signal));
}

export async function steerGoalWorker(events: EventBus, runId: string, task: string, signal?: AbortSignal): Promise<void> {
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
