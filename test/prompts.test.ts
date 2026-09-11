import { describe, expect, it } from "vitest";
import { planDrafting, upkeep, upkeepNudges } from "../src/prompts.js";

it("cycles the curated supervisor nudges without changing the shared upkeep instructions", () => {
	const base = upkeep("/plan.md");
	const variants = upkeepNudges.map((_, round) => upkeep("/plan.md", round));
	expect(new Set(variants).size).toBe(upkeepNudges.length);
	for (const text of variants) expect(text.endsWith(base)).toBe(true);
	expect(upkeep("/plan.md", upkeepNudges.length)).toBe(variants[0]);
	expect(base.startsWith("Plan upkeep:")).toBe(true);
});

describe("planning prompt", () => {
	it("requires fact finding or a focused question before a goal", () => {
		expect(planDrafting).toContain("Use read-only repository tools or web search when either can\nresolve a fact.");
		expect(planDrafting).toContain("Do not use a question quota");
		expect(planDrafting).toContain("Briefly reframe the request in your own words to check comprehension");
		expect(planDrafting).toContain("point as unknown; do not silently replace it with an inference or turn it into a new blocking decision");
		expect(planDrafting).toContain("answer materially reduces uncertainty\nwhile discovering the right plan");
		expect(planDrafting).toContain("self-contained: state the relevant\ncontext, use the human's language and ASD-STE100");
		expect(planDrafting).toContain("placeholder goal such as \"work out the thing\"");
		expect(planDrafting).toContain("Only withhold Ready for an unanswered choice that changes scope, spending, or the user-visible result");
	});

	it("anchors work and sign-off to the user-visible result", () => {
		expect(planDrafting).toContain("## User-visible result");
		expect(planDrafting).toContain("Take it from the original request, not from your implementation plan");
		expect(planDrafting).toContain("Future work may not defer any artifact or action named there");
	});
});
