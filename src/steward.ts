import { randomUUID } from "node:crypto";

const REGISTER_EVENT = "pi-subagents:runtime-agent-register:v1";
const RPC_REQUEST_EVENT = "subagents:rpc:v1:request";
const RPC_REPLY_PREFIX = "subagents:rpc:v1:reply:";
const ASYNC_COMPLETE_EVENT = "subagent:async-complete";
const RPC_VERSION = 1;
const RPC_TIMEOUT_MS = 15_000;
export const STEWARD_AGENT = "goal-steward";

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
}

export interface StewardDecision {
	verdict: "let_run" | "redirect" | "accept" | "reject";
	summary: string;
	nextAction?: string;
	missingEvidence?: string[];
}

export const stewardOutputSchema = {
	type: "object",
	properties: {
		verdict: { type: "string", enum: ["let_run", "redirect", "accept", "reject"] },
		summary: { type: "string", maxLength: 800 },
		nextAction: { type: "string", maxLength: 400 },
		missingEvidence: { type: "array", maxItems: 8, items: { type: "string", maxLength: 400 } },
	},
	required: ["verdict", "summary"],
	additionalProperties: false,
} as const;

export const stewardSystemPrompt = `You are the read-only goal steward for one Pi work session.
Act as its supervisor, mentor, project manager, and skeptical board member. Keep the high-level goal
and the human's stated result stable while the worker handles implementation detail.

The plan path arrives in every review. Read the complete plan from disk every time, including after
compaction. Treat User-visible result and User voice as the authority. The plan is maintained by the
worker; never edit it. Use read-only tools to inspect cited files when this changes your decision.

Spend few tokens. Call structured_output as soon as the evidence is sufficient. Do not send prose
before that call, write a review essay, restate the plan, or narrate routine progress. Return one verdict:
- let_run: progress follows the plan and no instruction is useful
- redirect: drift, a missed failure mode, or a specific better next action needs worker attention
- accept: only for a sign-off review whose evidence positively proves the discriminator
- reject: only for a sign-off review that names the missing evidence

For redirect, include one concrete nextAction. For reject, include missingEvidence. Contact the
parent only when an immediate decision is needed. Do not accept a confident summary as evidence.
You are advisory and read-only; pi-goals alone writes and signs off the plan.

— Pi/Codex`;

export function registerStewardAgent(events: EventBus, model: string | null): Registration {
	const request: Record<string, unknown> = {
		version: 1,
		name: STEWARD_AGENT,
		definition: {
			description: "Persistent read-only supervisor for one pi-goals plan.",
			systemPrompt: stewardSystemPrompt,
			tools: ["read", "grep", "find", "ls", "contact_supervisor"],
			excludeTools: ["bash", "edit", "write", "subagent"],
			allowNestedSubagents: false,
			...(model ? { model } : {}),
			thinking: "low",
			systemPromptMode: "replace",
			inheritProjectContext: false,
			inheritGlobalContext: false,
			inheritSkills: false,
			defaultContext: "fresh",
			defaultAsync: true,
			defaultTimeoutMs: 300_000,
			acceptanceRole: "read-only",
			defaultProgress: false,
			toolBudget: { soft: 8, hard: 12, block: ["read", "grep", "find", "ls"] },
		},
	};
	events.emit(REGISTER_EVENT, request);
	const result = request.result as { ok?: boolean; registration?: Registration; error?: Error } | undefined;
	if (!result) throw new Error("pi-subagents is not installed or not ready.");
	if (!result.ok || !result.registration) throw result.error ?? new Error("pi-subagents rejected the goal-steward agent.");
	return result.registration;
}

export function readyReview(planPath: string): string {
	return `Review reason: plan approved\nPlan path: ${planPath}\n\nRead the complete plan now. Check that its goals still match the user-visible result and that the first work step is sensible. This is not sign-off: return only let_run or redirect.`;
}

export function checkpointReview(planPath: string, staleTurns: number): string {
	return `Review reason: progress checkpoint\nPlan path: ${planPath}\n\nThe worker completed ${staleTurns} turns without changing the plan's working set. Read the complete plan now and inspect only files needed to decide whether one concrete redirect would help. This is not sign-off: return only let_run or redirect.`;
}

export function signoffReview(planPath: string, goal: string): string {
	return `Review reason: goal sign-off\nPlan path: ${planPath}\nClaimed goal: ${goal}\n\nRead the complete plan now. Check User-visible result, User voice, this goal's discriminator, failure mode, and evidence. Inspect the cited files. Return accept only when the evidence positively proves the requested result; otherwise return reject and name the missing evidence.`;
}

async function rpc(events: EventBus, method: "spawn" | "resume", params: Record<string, unknown>, signal?: AbortSignal): Promise<RpcData> {
	if (signal?.aborted) throw new Error("Goal-steward request aborted.");
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
			reject(new Error("Goal-steward request aborted."));
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

export async function startSteward(events: EventBus, cwd: string, task: string, signal?: AbortSignal): Promise<string> {
	const data = await rpc(events, "spawn", {
		agent: STEWARD_AGENT,
		task,
		cwd,
		context: "fresh",
		async: true,
		mission: false,
		outputSchema: stewardOutputSchema,
	}, signal);
	return asyncRunId(data);
}

export async function resumeSteward(events: EventBus, runId: string, task: string, signal?: AbortSignal): Promise<string> {
	const data = await rpc(events, "resume", { id: runId, message: task }, signal);
	return asyncRunId(data);
}

function completionRunId(raw: unknown): string | null {
	if (!raw || typeof raw !== "object") return null;
	const runId = (raw as Record<string, unknown>).runId;
	return typeof runId === "string" ? runId : null;
}

export async function runStewardReview(
	events: EventBus,
	cwd: string,
	previousRunId: string | null,
	task: string,
	signal?: AbortSignal,
	timeoutMs = 600_000,
	onRunId?: (runId: string) => void,
): Promise<{ runId: string; decision: StewardDecision }> {
	if (signal?.aborted) throw new Error("Goal-steward review aborted.");
	let expectedRunId: string | null = null;
	const earlyCompletions: unknown[] = [];
	let settle: (raw: unknown) => void = () => {};
	let fail: (error: Error) => void = () => {};
	let timer: ReturnType<typeof setTimeout> | undefined;
	const completion = new Promise<StewardDecision>((resolve, reject) => {
		settle = (raw) => {
			try {
				resolve(parseStewardDecision(raw));
			} catch (error) {
				reject(error);
			}
		};
		fail = reject;
	});
	const unsubscribe = events.on(ASYNC_COMPLETE_EVENT, (raw) => {
		const completedRunId = completionRunId(raw);
		if (expectedRunId === null) {
			earlyCompletions.push(raw);
			return;
		}
		if (completedRunId === expectedRunId) settle(raw);
	});
	const onAbort = () => fail(new Error("Goal-steward review aborted."));
	try {
		expectedRunId = previousRunId
			? await resumeSteward(events, previousRunId, task, signal)
			: await startSteward(events, cwd, task, signal);
		onRunId?.(expectedRunId);
		if (signal?.aborted) throw new Error("Goal-steward review aborted.");
		signal?.addEventListener("abort", onAbort, { once: true });
		timer = setTimeout(() => fail(new Error(`Goal-steward review timed out after ${timeoutMs / 1000}s.`)), timeoutMs);
		timer.unref();
		const early = earlyCompletions.find((raw) => completionRunId(raw) === expectedRunId);
		if (early) settle(early);
		return { runId: expectedRunId, decision: await completion };
	} finally {
		if (timer) clearTimeout(timer);
		unsubscribe();
		signal?.removeEventListener("abort", onAbort);
	}
}

export function parseStewardDecision(raw: unknown): StewardDecision {
	if (!raw || typeof raw !== "object") throw new Error("Goal-steward completion was not an object.");
	const results = (raw as Record<string, unknown>).results;
	if (!Array.isArray(results) || results.length !== 1 || !results[0] || typeof results[0] !== "object") {
		throw new Error("Goal-steward completion did not contain exactly one result.");
	}
	const child = results[0] as Record<string, unknown>;
	if (child.success === false) throw new Error(typeof child.error === "string" ? child.error : "Goal-steward run failed.");
	const value = child.structuredOutput;
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Goal-steward returned no structured verdict.");
	const decision = value as Record<string, unknown>;
	if (!(["let_run", "redirect", "accept", "reject"] as unknown[]).includes(decision.verdict) || typeof decision.summary !== "string" || !decision.summary.trim()) {
		throw new Error("Goal-steward returned an invalid structured verdict.");
	}
	if (decision.verdict === "redirect" && (typeof decision.nextAction !== "string" || !decision.nextAction.trim())) {
		throw new Error("Goal-steward redirect omitted nextAction.");
	}
	if (
		decision.verdict === "reject"
		&& (!Array.isArray(decision.missingEvidence) || decision.missingEvidence.length === 0 || decision.missingEvidence.some((item) => typeof item !== "string" || !item.trim()))
	) {
		throw new Error("Goal-steward rejection omitted missingEvidence.");
	}
	return decision as unknown as StewardDecision;
}
