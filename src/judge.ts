// PI/OpenAI: stateless read-only judge (sign-off, and review of a stop) through pi-subagents' structured delegation events.
// PI/OpenAI: register an explicit read-only agent rather than trust a user-overridden reviewer.
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { registerAgentViaEvents } from "pi-subagents/agents";
import {
	SUBAGENT_DELEGATION_CANCEL_EVENT,
	SUBAGENT_DELEGATION_REQUEST_EVENT,
	SUBAGENT_DELEGATION_RESPONSE_EVENT,
	SUBAGENT_DELEGATION_STARTED_EVENT,
	type SubagentDelegationRequest,
	type SubagentDelegationResponse,
} from "pi-subagents/delegation";
import { judgeSystem, judgeTask } from "./prompts.js";

export const JUDGE_AGENT = "pi-goals-judge";
const START_TIMEOUT_MS = 15_000;
const JUDGE_TIMEOUT_MS = 600_000;

interface Events {
	emit(channel: string, data: unknown): void;
	on(channel: string, handler: (data: unknown) => void): () => void;
}
export interface JudgeCheck {
	path: string;
	quote: string;
	observation: string;
}
export interface JudgeVerdict {
	verdict: "accept" | "reject";
	checks: JudgeCheck[];
	missing: string;
}
export interface StopVerdict {
	verdict: "continue" | "wait" | "blocked";
	reason: string;
	next: string;
	comment: string;
}
/** The structured value a fresh judge returned, not yet checked for shape. */
export type JudgeResult = { ok: true; value: unknown; model?: string } | { ok: false; error: string };

/** The sign-off task: the goals file, and the project's AGENTS.md as a separate source. */
export function signOffTask(text: string, path: string, cwd: string, history: string): string {
	const project: { path: string; text?: string } = { path: resolve(cwd, "AGENTS.md") };
	try { project.text = readFileSync(project.path, "utf8"); } catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	return judgeTask(text, path, project, history);
}

export function runJudge(
	events: Events,
	input: { task: string; schema: Record<string, unknown>; cwd: string; model?: string },
	signal?: AbortSignal,
	timeouts = { startMs: START_TIMEOUT_MS, totalMs: JUDGE_TIMEOUT_MS },
): Promise<JudgeResult> {
	const identity = { requestId: randomUUID(), ownerRunId: `pi-goals-${randomUUID()}`, nodeId: "judge" };
	const request: SubagentDelegationRequest = {
		...identity,
		agent: JUDGE_AGENT,
		task: input.task,
		context: "fresh",
		cwd: input.cwd,
		...(input.model ? { model: input.model } : {}),
		timeoutMs: timeouts.totalMs,
		result: { kind: "structured", schema: input.schema },
	};
	return new Promise((resolve) => {
		let registration: { dispose(): void };
		try {
			registration = registerAgentViaEvents({ pi: { events }, name: JUDGE_AGENT, definition: {
				description: "Read-only goal artifact judge", systemPrompt: judgeSystem,
				tools: ["read", "grep", "find", "ls"], excludeTools: ["bash", "edit", "write"],
				allowNestedSubagents: false, inheritSkills: false, inheritProjectContext: false,
				inheritGlobalContext: false, systemPromptMode: "replace", defaultContext: "fresh", acceptanceRole: "read-only",
			} });
		} catch (error) { resolve({ ok: false, error: String(error) }); return; }
		const cleanups: Array<() => void> = [() => registration.dispose()];
		const done = (result: JudgeResult) => {
			for (const cleanup of cleanups.splice(0)) cleanup();
			resolve(result);
		};
		const mine = (data: unknown) => {
			const value = data as Partial<typeof identity> | undefined;
			return value?.requestId === identity.requestId && value.ownerRunId === identity.ownerRunId && value.nodeId === identity.nodeId;
		};
		const startTimer = setTimeout(() => {
			done({ ok: false, error: `pi-subagents did not start the judge within ${timeouts.startMs / 1000}s` });
			events.emit(SUBAGENT_DELEGATION_CANCEL_EVENT, identity);
		}, timeouts.startMs);
		const totalTimer = setTimeout(() => {
			done({ ok: false, error: `judge timed out after ${timeouts.totalMs / 1000}s` });
			events.emit(SUBAGENT_DELEGATION_CANCEL_EVENT, identity);
		}, timeouts.totalMs + timeouts.startMs);
		cleanups.push(() => clearTimeout(startTimer), () => clearTimeout(totalTimer));
		cleanups.push(events.on(SUBAGENT_DELEGATION_STARTED_EVENT, (data) => { if (mine(data)) clearTimeout(startTimer); }));
		cleanups.push(events.on(SUBAGENT_DELEGATION_RESPONSE_EVENT, (data) => { if (mine(data)) done(fromResponse(data as SubagentDelegationResponse)); }));
		const abort = () => {
			done({ ok: false, error: "judge aborted" });
			events.emit(SUBAGENT_DELEGATION_CANCEL_EVENT, identity);
		};
		if (signal?.aborted) return abort();
		signal?.addEventListener("abort", abort, { once: true });
		cleanups.push(() => signal?.removeEventListener("abort", abort));
		events.emit(SUBAGENT_DELEGATION_REQUEST_EVENT, request);
	});
}

function fromResponse(response: SubagentDelegationResponse): JudgeResult {
	if (response.status !== "completed") return { ok: false, error: `judge ${response.status}${response.error ? `: ${response.error}` : ""}` };
	if (response.result?.kind !== "structured" || !response.result.value) return { ok: false, error: "judge returned no structured verdict" };
	return { ok: true, value: response.result.value, model: response.model };
}

const NO_VERDICT = "judge returned no structured verdict";
function signOffVerdict(value: unknown): JudgeVerdict | undefined {
	const v = value as JudgeVerdict;
	const malformed = (v.verdict !== "accept" && v.verdict !== "reject") || !Array.isArray(v.checks) || typeof v.missing !== "string" || v.checks.some(c => !c || typeof c.path !== "string" || !c.path.trim() || typeof c.quote !== "string" || !c.quote.trim() || typeof c.observation !== "string" || !c.observation.trim());
	return malformed ? undefined : v;
}

/** A stop review, or why there is none. */
export function stopVerdict(result: JudgeResult): StopVerdict | { error: string } {
	if (!result.ok) return { error: result.error };
	const v = result.value as StopVerdict;
	if (!["continue", "wait", "blocked"].includes(v.verdict) || typeof v.reason !== "string" || !v.reason.trim() || typeof v.next !== "string" || typeof v.comment !== "string") return { error: NO_VERDICT };
	return v;
}

export interface SignOff {
	text: string;
	isError: boolean;
	accepted: boolean;
	/** One line for ## Evidence when accepted. */
	log: string;
}

const oneLine = (s: string) => s.replace(/\s+/g, " ").trim().slice(0, 200);

export function decideSignOff(result: JudgeResult): SignOff {
	const value = result.ok ? signOffVerdict(result.value) : undefined;
	if (!result.ok || !value) {
		const error = result.ok ? NO_VERDICT : result.error;
		return {
			text: `Sign-off judge unavailable (${error}). The goal is unchanged. Resolve the failure or ask the user whether to disable the sign-off judge.`,
			isError: true, accepted: false,
			log: `review failed (sign-off judge unavailable: ${oneLine(error)})`,
		};
	}
	const { verdict, checks, missing } = value;
	const review = checks.map((check) => `- ${check.path}: "${check.quote}" -> ${check.observation}`).join("\n");
	if (verdict === "accept" && checks.length > 0 && !missing.trim()) {
		return { text: `Sign-off ACCEPTED; the goal is finished.\n\nSign-off judge checks:\n${review}`, isError: false, accepted: true, log: `accepted by the sign-off judge${result.model ? ` (${result.model})` : ""}` };
	}
	const why = verdict === "accept" ? "the sign-off judge accepted without citing any file it opened" : missing || "no reason given";
	return { text: `Sign-off REJECTED. Missing:\n${why}${review ? `\n\nSign-off judge checks:\n${review}` : ""}`, isError: true, accepted: false, log: `rejected: ${oneLine(why)}` };
}
