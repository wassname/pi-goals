import { describe, expect, it } from "vitest";
import { planDrafting, planningState } from "../src/prompts.js";

describe("planning prompt", () => {
	it("requires fact finding or a focused question before a goal", () => {
		expect(planDrafting).toContain("Use read-only repository tools and web search");
		expect(planDrafting).toContain("ask the human to confirm your interpretation");
		expect(planDrafting).toContain("approve an editorial or other preference choice");
		expect(planDrafting).toContain("placeholder\ngoal such as \"work out the thing\"");
		expect(planDrafting).toContain("object, observable result, settled scope, and required approval");
	});

	it("restores the same rule after compaction", () => {
		expect(planningState(".pi/plan/test.md")).toContain("web search");
		expect(planningState(".pi/plan/test.md")).toContain("choice\nthat needs their approval");
	});
});
