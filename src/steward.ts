import { randomUUID } from "node:crypto";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const SUBAGENT_RPC_REQUEST_EVENT = "subagents:rpc:v1:request";
export const SUBAGENT_RPC_REPLY_PREFIX = "subagents:rpc:v1:reply:";
export const SUBAGENT_ASYNC_COMPLETE_EVENT = "subagent:async-complete";

export type StewardDecisionName = "approve" | "revise_plan" | "needs_user";

export interface StewardDecision {
	decision: StewardDecisionName;
	reason: string;
	nextAction: string;
	contractDrift: string[];
	unresolvedDecisions: string[];
}

export function stewardContract(plan: string, options: { preserveGoalStatus?: boolean } = {}): string {
	const output: string[] = [];
	let evidenceIndent: number | null = null;
	for (const line of plan.split("\n")) {
		const indent = line.match(/^\s*/)?.[0].length ?? 0;
		if (evidenceIndent !== null) {
			if (!line.trim()) continue;
			if (!line.startsWith("#") && indent > evidenceIndent) continue;
			evidenceIndent = null;
		}
		if (/^\s*-\s*evidence\s*:/i.test(line)) {
			output.push(line.replace(/:.*/, ": (checked separately by the fresh evidence judge)"));
			evidenceIndent = indent;
			continue;
		}
		const goalLine = /^\s*(?:\d+\.|[-*])\s*\[[ xX/-]\]\s*goal:/i.test(line);
		output.push(goalLine && options.preserveGoalStatus ? line : line.replace(/\[[ xX/-]\]/g, "[ ]"));
	}
	return output.join("\n").trimEnd();
}

export const STEWARD_OUTPUT_SCHEMA = {
	type: "object",
	additionalProperties: false,
	required: ["decision", "reason", "nextAction", "contractDrift", "unresolvedDecisions"],
	properties: {
		decision: { enum: ["approve", "revise_plan", "needs_user"] },
		reason: { type: "string" },
		nextAction: { type: "string" },
		contractDrift: { type: "array", items: { type: "string" } },
		unresolvedDecisions: { type: "array", items: { type: "string" } },
	},
} as const;

interface RpcReply {
	version: 1;
	requestId: string;
	success: boolean;
	data?: unknown;
	error?: { code?: string; message?: string };
}

function record(value: unknown): Record<string, unknown> | null {
	return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

export function rpcText(data: unknown): string {
	const top = record(data);
	return typeof top?.text === "string" ? top.text : "";
}

export function rpcRunId(data: unknown): string | null {
	const top = record(data);
	const details = record(top?.details);
	for (const value of [details?.runId, top?.runId, top?.id]) {
		if (typeof value === "string" && value.trim()) return value;
	}
	return null;
}

export function parseStewardDecision(value: unknown): StewardDecision | null {
	const input = record(value);
	if (!input) return null;
	if (input.decision !== "approve" && input.decision !== "revise_plan" && input.decision !== "needs_user") return null;
	if (typeof input.reason !== "string" || typeof input.nextAction !== "string") return null;
	if (!Array.isArray(input.contractDrift) || !input.contractDrift.every((item) => typeof item === "string")) return null;
	if (!Array.isArray(input.unresolvedDecisions) || !input.unresolvedDecisions.every((item) => typeof item === "string")) return null;
	const contractDrift = input.contractDrift as string[];
	const unresolvedDecisions = input.unresolvedDecisions as string[];
	const decision = input.decision === "approve" && unresolvedDecisions.length
		? "needs_user"
		: input.decision === "approve" && contractDrift.length
			? "revise_plan"
			: input.decision;
	return {
		decision,
		reason: input.reason,
		nextAction: input.nextAction,
		contractDrift,
		unresolvedDecisions,
	};
}

export function stewardCompletion(payload: unknown): { runId: string; decision: StewardDecision | null; error: string | null } | null {
	const input = record(payload);
	const runId = typeof input?.runId === "string" ? input.runId : typeof input?.id === "string" ? input.id : null;
	if (!runId) return null;
	const results = Array.isArray(input?.results) ? input.results : [];
	const first = record(results[0]);
	const effects = record(first?.effects);
	const fileMutation = record(effects?.fileMutation);
	const mutationObserved = fileMutation?.status === "observed" || fileMutation?.attempted === true;
	const decision = parseStewardDecision(first?.structuredOutput);
	const error = mutationObserved
		? "steward attempted or produced a file mutation"
		: typeof first?.error === "string"
			? first.error
			: input?.success === false
				? typeof input?.summary === "string" ? input.summary : "steward subagent failed"
				: decision ? null : "steward returned no valid structured decision";
	return { runId, decision, error };
}

export async function subagentRpc(
	pi: ExtensionAPI,
	method: "spawn" | "resume" | "status",
	params: Record<string, unknown>,
	timeoutMs = 5_000,
): Promise<unknown> {
	const requestId = randomUUID();
	const replyEvent = `${SUBAGENT_RPC_REPLY_PREFIX}${requestId}`;
	return new Promise((resolve, reject) => {
		let settled = false;
		let timer: ReturnType<typeof setTimeout>;
		const unsubscribe = pi.events.on(replyEvent, (value: unknown) => {
			if (settled) return;
			const reply = record(value) as RpcReply | null;
			if (!reply || reply.requestId !== requestId) return;
			settled = true;
			clearTimeout(timer);
			if (typeof unsubscribe === "function") unsubscribe();
			if (reply.success) resolve(reply.data);
			else reject(new Error(reply.error?.message ?? `pi-subagents ${method} failed`));
		});
		timer = setTimeout(() => {
			if (settled) return;
			settled = true;
			if (typeof unsubscribe === "function") unsubscribe();
			reject(new Error(`pi-subagents ${method} RPC did not reply within ${timeoutMs}ms`));
		}, timeoutMs);
		pi.events.emit(SUBAGENT_RPC_REQUEST_EVENT, {
			version: 1,
			requestId,
			method,
			params,
			source: { extension: "pi-goals" },
		});
	});
}
