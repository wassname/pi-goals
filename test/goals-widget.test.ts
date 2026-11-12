import { stripVTControlCharacters } from "node:util";
import { describe, expect, it } from "vitest";
import { ageTasks, aim, fold, goals, hasRemainingGoals, loopFocus, markGoal, waitingTasks, widgetLines } from "../src/goals.js";

describe("widget", () => {
	it("is empty when no goal is active and nothing waits on the user", () => {
		expect(widgetLines("1. [x] goal: Self-verified\n2. [✓] goal: Judge accepted\n3. [-] goal: Cancelled\n4. [ ] goal: Open")).toEqual([]);
	});

	it("gives each active goal one line: tasks finished, the task in progress, and how many more are in progress", () => {
		const text = "1. [/] goal: First\n   - tasks:\n     1. [x] a\n     2. [ ] b\n     3. [/] c\n        - details: hidden\n     4. [/] d\n2. [/] goal: No tasks yet\n3. [/] goal: Third\n4. [/] goal: Fourth\n5. [ ] goal: Open";
		expect(widgetLines(text)).toEqual(["◼ G1 1/4 · c · +1 in progress", "◼ G2 · No tasks yet", "◼ G3 · Third", "◼ … 1 more active goals"]);
		const long = text.replace("[/] c", `[/] ${"long label ".repeat(20)}`);
		expect(stripVTControlCharacters(widgetLines(long, 60)[0])).toMatch(/^◼ G1 1\/4 · long label .*… · \+1 in progress$/);
		expect(widgetLines(long, 20)[0]).not.toContain("in progress");
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
		const lines = widgetLines(text);
		expect(lines.slice(0, 2).map((line) => line.startsWith("?"))).toEqual([true, true]);
		expect(lines[0]).toContain("G1");
		expect(lines[0]).toContain("Log or linear y axis?");
		expect(lines[1]).toContain("Which venue?");
		expect(lines.filter((line) => line.includes("Log or linear"))).toHaveLength(1);
		expect(lines).toContain("◼ G1 1/3 · draw it");
		expect(lines).toContain("◼ G2 1/1 · note");
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


describe("what a resync sends", () => {
	const text = "# Title\n\nThe aim.\n\n## Goals\n\n1. [/] goal: plot\n   - discriminator: kept\n   - tasks:\n     1. [x] load\n        - result: 3 rows\n     2. [x] clean\n     3. [/] draw\n        - details: log axis\n     4. [ ] label\n        - details: later\n     5. [?] Which venue?\n        - options: A or B\n   - evidence: (empty)\n2. [✓] goal: old\n   - evidence: long\n3. [x] goal: reported\n   - evidence: awaits the judge\n\n## Review preview\n\nA table.\n\n## User voice\n\n- > \"make a plot\"\n\n## Loop statement\n\nGo.\n\n## Log\n\n- history\n";

	it("puts the aim and the user's words before the goals, whatever the file order", () => {
		const { top } = fold(text);
		const at = ["# Title\n\nThe aim.", "## User voice", "## Goals", "## Review preview", "## Loop statement"].map((part) => top.indexOf(part));
		expect(at).toEqual([...at].sort((a, b) => a - b));
		expect(at[0]).toBe(0);
		expect(top).not.toContain("history");
	});

	it("counts finished tasks, keeps notes only for tasks in progress or waiting on the user, and shortens accepted goals", () => {
		const { top } = fold(text);
		for (const kept of ["discriminator: kept", "     (2 finished tasks left out)\n     3. [/] draw\n        - details: log axis\n     4. [ ] label\n     5. [?] Which venue?\n        - options: A or B\n   - evidence: (empty)\n2. [✓] goal: old\n3. [x] goal: reported\n   - evidence: awaits the judge"]) expect(top).toContain(kept);
		for (const left of ["load", "3 rows", "clean", "later", "evidence: long"]) expect(top).not.toContain(left);
	});

	it("reads the aim under the title, or ## User-visible result in an older file", () => {
		expect(aim(text)).toBe("The aim.");
		expect(aim("# Title\n\nProvenance note.\n\n## User-visible result\n\nA plot.\n\n## Goals\n")).toBe("A plot.");
		expect(aim("# Title\n\n## Goals\n")).toBeUndefined();
		expect(() => loopFocus("# Title\n\n## Goals\n\n1. [/] goal: plot\n")).toThrow();
	});
});
