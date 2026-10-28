import { describe, expect, it } from "vitest";
import { goals, loopFocus, markGoal, widgetLines } from "../src/goals.js";

describe("goal status glyphs", () => {
	it("shows self-verified goals as checked, distinct from accepted and cancelled", () => {
		const goals = "1. [x] goal: Self-verified\n2. [✓] goal: Judge accepted\n3. [-] goal: Cancelled";
		expect(widgetLines(goals, "goals.md")).toEqual([
			"☑ G1: Self-verified", "✓ G2: Judge accepted", "✗ G3: Cancelled", "goals.md",
		]);
	});

	it("uses the same checked glyph in hidden-goal counts", () => {
		const goals = "1. [/] goal: First\n2. [/] goal: Second\n3. [/] goal: Third\n4. [x] goal: Self-verified";
		expect(widgetLines(goals, "goals.md").at(-1)).toBe("… 1 ☑; goals.md");
	});

	it("reads goals from the markdown tree, not from lines in code blocks", () => {
		const text = "## User-visible result\n\nA plot.\n\n> 1. [/] goal: real\n\n## Goals\n\n```md\n1. [/] goal: example in a fence\n```\n\n1. [/] goal: real\n   - notes: " + "long ".repeat(60) + "\n   - discriminator: kept in full\n\n   ### Completion criteria\n\n   all 6,149 cases\n\n## Log\n\n1. [ ] goal: below the fold\n";
		expect(goals(text).map((goal) => goal.subject)).toEqual(["real"]);
		const focus = loopFocus(text);
		expect(focus).toContain("discriminator: kept in full");
		expect(focus).toContain("all 6,149 cases");
		expect(focus).toContain(`notes: ${"long ".repeat(20)}`);
		expect(focus).not.toContain("long ".repeat(40));
		expect(markGoal(text, "real", "x")).toBe(text.replace("```\n\n1. [/] goal: real", "```\n\n1. [x] goal: real"));
	});
});
