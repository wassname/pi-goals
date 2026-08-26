import { describe, expect, it } from "vitest";
import { planDrafting, planningState } from "../src/prompts.js";

describe("planning prompt", () => {
	it("requires fact finding or a focused question before a goal", () => {
		expect(planDrafting).toContain("Use read-only tools to resolve discoverable facts.");
		expect(planDrafting).toContain("ask the\nhuman one focused question");
		expect(planDrafting).toContain("placeholder goal such as \"work out the thing\"");
		expect(planDrafting).toContain("object and an observable result");
	});

	it("restores the same rule after compaction", () => {
		expect(planningState(".pi/plan/test.md")).toContain("Use read-only tools to find facts yourself");
		expect(planningState(".pi/plan/test.md")).toContain("one focused question");
	});
});
