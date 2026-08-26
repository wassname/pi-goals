import { describe, expect, it } from "vitest";
import { planDrafting, planningState } from "../src/prompts.js";

describe("planning prompt", () => {
	it("requires fact finding or a focused question before a goal", () => {
		expect(planDrafting).toContain("Use read-only repository tools or web search when either can\nresolve a fact.");
		expect(planDrafting).toContain("ask the human to confirm your interpretation");
		expect(planDrafting).toContain("approve an editorial or other preference choice");
		expect(planDrafting).toContain("answer materially reduces uncertainty\nwhile discovering the right plan");
		expect(planDrafting).toContain("state the relevant context, use the human's language and ASD-STE100");
		expect(planDrafting).toContain("placeholder goal such as \"work out the thing\"");
		expect(planDrafting).toContain("object, observable result, settled scope, and required approval");
	});

	it("restores the same rule after compaction", () => {
		expect(planningState(".pi/plan/test.md")).toContain("web search\nwhen either can resolve a fact.");
		expect(planningState(".pi/plan/test.md")).toContain("choice that needs their approval");
		expect(planningState(".pi/plan/test.md")).toContain("self-contained round with relevant context and a recommendation");
	});
});
