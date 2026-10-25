import { describe, expect, it } from "vitest";
import { widgetLines } from "../src/goals.js";

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
});
