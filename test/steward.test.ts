import { describe, expect, it } from "vitest";
import { parseStewardDecision, rpcRunId, stewardCompletion, stewardContract } from "../src/steward.js";

const decision = {
	decision: "approve",
	reason: "The goal remains faithful.",
	nextAction: "Send it to the evidence judge.",
	contractDrift: [],
	unresolvedDecisions: [],
};

describe("persistent steward protocol", () => {
	it("extracts run ids from pi-subagents RPC replies", () => {
		expect(rpcRunId({ details: { runId: "run-1" } })).toBe("run-1");
		expect(rpcRunId({ runId: "run-2" })).toBe("run-2");
		expect(rpcRunId({ details: {} })).toBeNull();
	});

	it("accepts only the bounded structured decision", () => {
		expect(parseStewardDecision(decision)).toEqual(decision);
		expect(parseStewardDecision({ ...decision, decision: "done" })).toBeNull();
		expect(parseStewardDecision({ ...decision, unresolvedDecisions: "none" })).toBeNull();
		expect(parseStewardDecision({ ...decision, unresolvedDecisions: ["Choose the published scope."] })?.decision).toBe("needs_user");
		expect(parseStewardDecision({ ...decision, contractDrift: ["The output changed."] })?.decision).toBe("revise_plan");
	});

	it("keeps the approved contract compact across progress and evidence growth", () => {
		const plan = `1. [/] goal: make the file
  - discriminator: the file can be read
  - tasks:
    1. [x] write it
  - evidence:
    - huge quoted log
    - another artifact

2. [ ] goal: publish it`;
		expect(stewardContract(plan)).toBe(`1. [ ] goal: make the file
  - discriminator: the file can be read
  - tasks:
    1. [ ] write it
  - evidence: (checked separately by the fresh evidence judge)
2. [ ] goal: publish it`);
		expect(stewardContract(plan, { preserveGoalStatus: true })).toContain("1. [/] goal: make the file");
	});

	it("correlates a structured completion by run id", () => {
		expect(stewardCompletion({
			runId: "run-3",
			success: true,
			results: [{ structuredOutput: decision }],
		})).toEqual({ runId: "run-3", decision, error: null });
		expect(stewardCompletion({
			runId: "run-4",
			success: false,
			summary: "child failed",
			results: [{}],
		})).toEqual({ runId: "run-4", decision: null, error: "child failed" });
		expect(stewardCompletion({
			runId: "run-5",
			success: true,
			results: [{ structuredOutput: decision, effects: { fileMutation: { status: "observed", attempted: true } } }],
		})?.error).toBe("steward attempted or produced a file mutation");
	});
});
