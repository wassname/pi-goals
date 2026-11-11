import { describe, expect, it } from "vitest";
import { ageTasks, goals, hasRemainingGoals, loopFocus, markGoal, waitingTasks, widgetLines } from "../src/goals.js";

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
		expect(loopFocus(text).endsWith("\n\nGoals:\n1. [/] goal: real")).toBe(true);
		expect(markGoal(text, "real", "x")).toBe(text.replace("```\n\n1. [/] goal: real", "```\n\n1. [x] goal: real"));
	});
});

describe("tasks that wait on the user", () => {
	const text = "## User-visible result\n\nA plot.\n\n## Goals\n\n1. [/] goal: plot\n   - tasks:\n     1. [?] Log or linear y axis?\n        - options: log shows the tail\n     2. [ ] draw it\n     3. [x] load\n2. [/] goal: note\n   - tasks:\n     1. [x] outline\n3. [ ] goal: publish\n   - tasks:\n     1. [?] Which venue?\n4. [✓] goal: old\n   - tasks:\n     1. [?] stale question\n";

	it("come first in the widget, apart from the agent's open tasks, and are not counted as done", () => {
		const lines = widgetLines(text, "goals.md");
		expect(lines.slice(0, 2).map((line) => line.startsWith("?"))).toEqual([true, true]);
		expect(lines[0]).toContain("G1");
		expect(lines[0]).toContain("Log or linear y axis?");
		expect(lines[1]).toContain("Which venue?");
		expect(lines.filter((line) => line.includes("Log or linear"))).toHaveLength(1);
		expect(lines).toContain("    [ ] draw it");
		expect(lines).toContain("    … 1 done");
		expect(lines.join("\n")).not.toContain("stale question");
		expect(waitingTasks(text)).toEqual([{ goal: 1, label: "Log or linear y axis?" }, { goal: 3, label: "Which venue?" }]);
	});

	it("are listed apart in the reminder, with active goals that have no open task", () => {
		const first = ageTasks(text, {}, 0);
		const later = ageTasks(text, first.since, 5 * 3_600_000);
		expect(later.lines).toEqual(["- G1 2. [ ] draw it · unchanged 5 h"]);
		expect(later.waiting).toEqual(["- G1 1. [?] Log or linear y axis? · unchanged 5 h", "- G3 1. [?] Which venue? · unchanged 5 h"]);
		expect(later.idle).toEqual(["G2"]);
		expect(hasRemainingGoals(text)).toBe(true);
	});
});

describe("task ages", () => {
	const H = 3_600_000;
	const file = (first: string, tasks: string) => `## User-visible result\n\nA plot.\n\n## Goals\n\n1. [${first}] goal: plot\n   - tasks:\n${tasks}\n2. [/] goal: note\n   - tasks:\n     1. [ ] write it\n`;
	const two = "     1. [ ] check\n     2. [ ] check\n";

	it("ages duplicate labels separately", () => {
		const first = ageTasks(file("/", two), {}, 0);
		const later = ageTasks(file("/", two), first.since, 6 * H);
		expect(later.lines.filter((line) => line.includes("check · unchanged 6 h"))).toHaveLength(2);
	});

	it("keeps ages when goals or tasks are renumbered, or a goal is paused for a wake", () => {
		const first = ageTasks(file("/", "     1. [ ] load\n     2. [ ] plot\n"), {}, 0);
		const reordered = ageTasks(file("/", "     1. [ ] plot\n     2. [ ] load\n"), first.since, 2 * H);
		expect(reordered.lines.join("\n")).toContain("load · unchanged 2 h");
		const paused = ageTasks(file(" ", "     1. [ ] plot\n     2. [ ] load\n"), reordered.since, 3 * H);
		expect(paused.lines.join("\n")).not.toContain("load");
		const resumed = ageTasks(file("/", "     1. [ ] plot\n     2. [ ] load\n"), paused.since, 4 * H);
		expect(resumed.lines.join("\n")).toContain("load · unchanged 4 h");
	});
});

