// PI/OpenAI: stateless sign-off judge through pi-subagents' structured delegation events.
// PI/OpenAI: register an explicit read-only agent rather than trust a user-overridden reviewer.
import { randomUUID } from "node:crypto";
import { registerAgentViaEvents } from "pi-subagents/agents";
import {
	SUBAGENT_DELEGATION_CANCEL_EVENT,
	SUBAGENT_DELEGATION_REQUEST_EVENT,
	SUBAGENT_DELEGATION_RESPONSE_EVENT,
	SUBAGENT_DELEGATION_STARTED_EVENT,
	type SubagentDelegationRequest,
	type SubagentDelegationResponse,
} from "pi-subagents/delegation";
import { judgeSchema, judgeSystem, judgeTask } from "./prompts.js";

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
export type JudgeResult = { ok: true; verdict: JudgeVerdict; model?: string } | { ok: false; error: string };

export function runJudge(
	events: Events,
	input: { goal: string; text: string; path: string; cwd: string; model?: string },
	signal?: AbortSignal,
	timeouts = { startMs: START_TIMEOUT_MS, totalMs: JUDGE_TIMEOUT_MS },
): Promise<JudgeResult> {
	const identity = { requestId: randomUUID(), ownerRunId: `pi-goals-${randomUUID()}`, nodeId: "judge" };
	const request: SubagentDelegationRequest = {
		...identity,
		agent: JUDGE_AGENT,
		task: judgeTask(input.goal, input.text, input.path),
		context: "fresh",
		cwd: input.cwd,
		...(input.model ? { model: input.model } : {}),
		timeoutMs: timeouts.totalMs,
		result: { kind: "structured", schema: judgeSchema },
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
	const value = response.result?.kind === "structured" ? (response.result.value as JudgeVerdict) : undefined;
	if (!value || (value.verdict !== "accept" && value.verdict !== "reject") || !Array.isArray(value.checks) || typeof value.missing !== "string" || value.checks.some(c => !c || typeof c.path !== "string" || !c.path.trim() || typeof c.quote !== "string" || !c.quote.trim() || typeof c.observation !== "string" || !c.observation.trim())) {
		return { ok: false, error: "judge returned no structured verdict" };
	}
	return { ok: true, verdict: value, model: response.model };
}

export interface SignOff {
	text: string;
	isError: boolean;
	/** Checkbox to write, or undefined to leave the goal as it is. */
	mark?: "✓" | "x";
	log: string;
}

const oneLine = (s: string) => s.replace(/\s+/g, " ").trim().slice(0, 200);

export function decideSignOff(goal: string, result: JudgeResult): SignOff {
	if (!result.ok) {
		return {
			text: `Judge unavailable (${result.error}). The goal is unchanged. Resolve the judge failure or ask the user whether to disable independent judging.`,
			isError: true,
			log: `review failed "${goal}" (judge unavailable: ${oneLine(result.error)})`,
		};
	}
	const { verdict, checks, missing } = result.verdict;
	const review = checks.map((check) => `- ${check.path}: "${check.quote}" -> ${check.observation}`).join("\n");
	if (verdict === "accept" && checks.length > 0 && !missing.trim()) {
		return { text: `Sign-off ACCEPTED; goal marked [✓].\n\nJudge checks:\n${review}`, isError: false, mark: "✓", log: `accepted "${goal}" (judge${result.model ? ` ${result.model}` : ""})` };
	}
	const why = verdict === "accept" ? "judge accepted without citing any file it opened" : missing || "no reason given";
	return { text: `Sign-off REJECTED. Missing:\n${why}${review ? `\n\nJudge checks:\n${review}` : ""}`, isError: true, log: `rejected "${goal}": ${oneLine(why)}` };
}
