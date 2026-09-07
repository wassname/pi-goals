import { describe, expect, it } from "vitest";
import { completeGoalDescription, planDrafting, planningState, resync } from "../src/prompts.js";

describe("planning prompt", () => {
	it("requires fact finding or a focused question before a goal", () => {
		expect(planDrafting).toContain("Use read-only repository tools or web search when either can\nresolve a fact.");
		expect(planDrafting).toContain("Ask at least three short, concrete questions");
		expect(planDrafting).toContain("understand the requested outcome, boundary, and how success will be judged");
		expect(planDrafting).toContain("record that\npoint as unknown; do not silently replace it with an inference");
		expect(planDrafting).toContain("answer materially reduces uncertainty\nwhile discovering the right plan");
		expect(planDrafting).toContain("self-contained: state the relevant\ncontext, use the human's language and ASD-STE100");
		expect(planDrafting).toContain("placeholder goal such as \"work out the thing\"");
		expect(planDrafting).toContain("material user decisions remain open");
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
		expect(resync("plan", ".pi/plan/test.md", "Compacted.")).toContain("amend the plan rather than preserving an obsolete decision");
		expect(resync("plan", ".pi/plan/test.md", "Compacted.")).toContain("implementation worker");
		expect(completeGoalDescription).toContain("visible supervisor");
		expect(completeGoalDescription).toContain("stopped worker view with no active work");
	});
});
