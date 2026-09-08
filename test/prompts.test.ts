import { describe, expect, it } from "vitest";
import { alignmentPolicy, judgeSystem, planDrafting, planningState, reminder, resync, waivesAlignment } from "../src/prompts.js";

describe("planning prompt", () => {
	it("requires fact finding or a focused question before a goal", () => {
		expect(planDrafting).toContain("Use read-only repository tools or web search when either can\nresolve a fact.");
		expect(planDrafting).toContain("ask the human to confirm your interpretation");
		expect(planDrafting).toContain("approve an editorial or other preference choice");
		expect(planDrafting).toContain("ask at least THREE distinct task-specific alignment");
		expect(planDrafting).toContain("questions in ONE chat round");
		expect(planDrafting).toContain("Wait for the human's answers and use them");
		expect(planDrafting).toContain("self-contained: state the relevant\ncontext, use the human's language and ASD-STE100");
		expect(planDrafting).toContain("placeholder goal such as \"work out the thing\"");
		expect(planDrafting).toContain("object, observable result, settled scope, and required approval");
	});

	it("waives questions only for an explicit current-objective instruction", () => {
		for (const objective of ["fix it, no questions", "skip questions and implement", "do not ask me any questions", "no q's", "skip q's", "fix it; no q’s please"]) {
			expect(waivesAlignment(objective)).toBe(true);
			expect(alignmentPolicy(waivesAlignment(objective))).toContain("THIS plan only");
		}
		for (const objective of ["next objective", "fix the exporter; do not skip questions", "don't skip questions", "add a 'skip questions' button", 'add a "no questions" mode', 'document "first; skip questions; then build"']) expect(waivesAlignment(objective), objective).toBe(false);
		expect(alignmentPolicy(false)).toContain("previous plan does NOT apply");
	});

	it("restores the same rule after compaction", () => {
		expect(planningState(".pi/plan/test.md")).toContain("web search\nwhen either can resolve a fact.");
		expect(planningState(".pi/plan/test.md")).toContain("choice that needs their approval");
		expect(planningState(".pi/plan/test.md")).toContain("self-contained round with relevant context and a recommendation");
	});

	it("anchors work and sign-off to the user-visible result", () => {
		expect(planDrafting).toContain("## User-visible result");
		expect(planDrafting).toContain("Take it from the original request, not from your implementation plan");
		expect(planDrafting).toContain("Future work may not defer any artifact or action named there");
		expect(reminder("plan", ".pi/plan/test.md")).toContain("latest message outranks this plan");
		expect(resync("plan", ".pi/plan/test.md", "Compacted.")).toContain("amend the plan rather than preserving an obsolete decision");
		expect(judgeSystem).toContain("Task fidelity?");
		expect(judgeSystem).toContain("Agent-inferred scope is not authority");
	});
});
