import { stripVTControlCharacters } from "node:util";
import { describe, expect, it } from "vitest";
import { appendEvidence, dialogue, keepPage, lastLines, note, section, split, title, view, widgetLines, wordCount } from "../src/goals.js";
import { goalsTemplate } from "../src/prompts.js";
import { GOALS, LOOP, withNote } from "./harness.js";

describe("the page and the agent's notes", () => {
	it("splits at ## Resume here: the page above it, the notes from it to the end", () => {
		const text = withNote(GOALS, "Fitting the bars; rerun at 40 steps if it has not converged.");
		const { page, notes } = split(text);
		expect(page.endsWith(LOOP)).toBe(true);
		expect(notes.startsWith("## Resume here")).toBe(true);
		expect(notes).toContain("## Evidence");
		expect(split("# T\n\nAim.\n")).toEqual({ page: "# T\n\nAim.", notes: "" });
	});

	it("reads headings from the markdown tree, not from lines in code blocks or deeper headings", () => {
		const text = GOALS.replace("Make the plot.", "Make the plot.\n\n```md\n## Resume here\nnot a heading\n```\n\n### Resume here\n\nnot it either");
		expect(split(text).page).toContain("not it either");
		expect(section(text, "Goal")).toContain("not a heading");
		expect(section(text, "loop statement")).toBe(LOOP);
		expect(section(text, "Resume here")).toBe("");
		expect(section(text, "Missing")).toBeUndefined();
		expect(title(text)).toBe("Title");
	});

	it("keepPage undoes a change to the page and keeps the new notes", () => {
		const after = withNote(GOALS.replace("Make the plot.", "Make any plot; stop if none is found."), "new note");
		const kept = keepPage(GOALS, after)!;
		expect(split(kept).page).toBe(split(GOALS).page);
		expect(kept).toContain("new note");
		expect(keepPage(GOALS, withNote(GOALS, "new note"))).toBeUndefined();
		// An edit that also dropped the notes heading is undone whole.
		expect(keepPage(GOALS, "# Title\n\nSomething else.\n")).toBe(GOALS);
	});

	it("appendEvidence adds one list line under ## Evidence, creating it when missing", () => {
		const once = appendEvidence(GOALS, "accepted; reviews/a.json");
		const twice = appendEvidence(once, "second");
		expect(section(twice, "Evidence")).toBe("- accepted; reviews/a.json\n- second");
		expect(split(twice).page).toBe(split(GOALS).page);
		expect(section(appendEvidence("# T\n\nAim.\n", "x"), "Evidence")).toBe("- x");
	});

	it("the template is a valid page that fits the one-page limit", () => {
		expect(wordCount(split(goalsTemplate).page)).toBeLessThan(350);
		expect(section(goalsTemplate, "Loop statement")).toBeUndefined();
		// Every heading after the two the user approves is labelled as agent-written; lookups ignore the label.
		const headings = goalsTemplate.split("\n").filter((line) => line.startsWith("## "));
		expect(headings.slice(0, 2)).toEqual(["## Goal", "## Result mock-up"]);
		for (const heading of headings.slice(2)) expect(heading).toMatch(/^## Slop: /);
		expect(section("## Slop: Notes\n\n- x\n", "Notes")).toBe("- x");
		expect(title(goalsTemplate)).toBe("<short title>");
		for (const name of ["Goal", "Result mock-up", "Concepts", "Jargon", "Notes", "Resume here", "Evidence"]) expect(section(goalsTemplate, name)).toBeDefined();
		expect(goalsTemplate.indexOf("## Goal")).toBeLessThan(goalsTemplate.indexOf("## Result mock-up"));
		expect(goalsTemplate.indexOf("## Result mock-up")).toBeLessThan(goalsTemplate.indexOf("## Slop: Notes"));
	});

	it("re-sends the page, the first lines of the note and the newest evidence, and none of the rest of the appendix", () => {
		const lines = (n: number, word: string) => Array.from({ length: n }, (_, i) => `- ${word} ${i}`).join("\n");
		const text = `${withNote(GOALS, lines(18, "step")).trimEnd()}\n\n${lines(25, "result")}\n\n## OVERNIGHT\n\nNothing else runs until he picks.\n`;
		expect(note(text).split("\n")).toHaveLength(16);
		const sent = view(text);
		for (const kept of ["A plot. Make the plot.", "step 14", "3 more lines are not sent", "5 earlier lines are in the file", "result 24", "result 5"]) expect(sent).toContain(kept);
		expect(sent).not.toMatch(/step 15|result 4\n|OVERNIGHT|until he picks/);
		expect(view(GOALS)).toContain("## Slop: Resume here");
	});
});

describe("what the user typed, for a reader who was not there", () => {
	it("shows each message under a heading, after the quoted end of the agent message before it, given once", () => {
		const before = "I wrote file.m.\n\nIt plots the curve in pink.\nShall I go on?\n-- PI/Claude\n/work/.pi/goals/x-v1.md";
		expect(dialogue([{ at: "2026-01-01 10:00", text: "make a plot" }, { at: "2026-01-01 10:05", text: "I don't like it in pink.\nBrown please.", before }, { at: "2026-01-01 10:06", text: "or grey", before }])).toBe(
			"### User, 2026-01-01 10:00\nmake a plot\n\n### User, 2026-01-01 10:05\n(after the agent's message that ended: \"… I wrote file.m. / It plots the curve in pink. / Shall I go on?\")\nI don't like it in pink.\nBrown please.\n\n### User, 2026-01-01 10:06\nor grey");
		expect(dialogue([])).toBe("");
	});

	it("keeps the first and last 1,000 lines of a long history, and the two ends of a long message", () => {
		const many = Array.from({ length: 1500 }, (_, n) => ({ at: "t", text: `message ${n}` }));
		const lines = dialogue(many).split("\n");
		expect(lines).toHaveLength(2000);
		expect(lines.slice(0, 2)).toEqual(["### User, t", "message 0"]);
		expect(lines[1000]).toMatch(/^… \(2\d{3} lines of the middle of the conversation cut\) …$/);
		expect(lines.at(-1)).toBe("message 1499");
		const paste = dialogue([{ at: "t", text: Array.from({ length: 100 }, (_, n) => `row ${n} ${"y".repeat(500)}`).join("\n") }]).split("\n");
		expect(paste).toHaveLength(62);
		expect(paste[31]).toBe("… (40 lines cut) …");
		expect(paste[1]).toHaveLength(301);
		expect(paste.at(-1)).toMatch(/^row 99 y+…$/);
	});
});

describe("widget", () => {
	it("shows the status, the goal as written, and the note's Now line; expanded, the goal wrapped and the lines meant for the user", () => {
		expect(widgetLines(GOALS, "working")).toEqual(["● goal working · click to expand", "  A plot. Make the plot."]);
		const text = withNote(GOALS, "Saw: the fit converged in 12 steps.\nNow: drawing the bars.\nIf it fails: rerun at 40 steps.");
		expect(widgetLines(text, "working")).toEqual(["● goal working · click to expand", "  A plot. Make the plot.", "  → Now: drawing the bars."]);
		expect(widgetLines(text, "accepted", 100, { expanded: true })).toEqual(["● goal accepted · click to collapse", "  A plot. Make the plot.", "", "  Now: drawing the bars."]);
		// Saw and If it fails are for the agent; the user sees what needs them, what they should know, and Now.
		const asking = withNote(GOALS, "Saw: two candidate axes.\nNow: mapping at layer 16.\nNeeds you: layer 16 or 20 for the map? I use 16 until you say.\nYou should know: the first search did not converge.");
		expect(widgetLines(asking, "working")).toEqual(["● goal working · 1 needs you · click to expand", "  A plot. Make the plot.", "  ? Needs you: layer 16 or 20 for the map? I use 16 until you say.", "  → Now: mapping at layer 16."]);
		const painted = widgetLines(asking, "working", 100, { expanded: true, style: { fg: (color: string, s: string) => `<${color}>${s}</>` } });
		expect(painted).toContain("  <warning>Needs you: layer 16 or 20 for the map? I use 16 until you say.</>");
		expect(painted).toContain("  <accent>You should know: the first search did not converge.</>");
		const path = { short: ".pi/goals/abc-v1.md", full: "/work/project/.pi/goals/abc-v1.md" };
		expect(widgetLines(asking, "working", 100, { path })[0]).toBe("● goal working · 1 needs you · .pi/goals/abc-v1.md · click to expand");
		expect(widgetLines(asking, "working", 40, { path, expanded: true }).slice(0, 2).map(stripVTControlCharacters)).toEqual(["● goal working · 1 needs you · click to…", "  /work/project/.pi/goals/abc-v1.md"]);
		// The goal is its first paragraph, on one line; a list under it is not shown, and a long goal ends in an ellipsis.
		const long = GOALS.replace("A plot. Make the plot.", `"we want the plot,\nwith error bars." One goal:\n1. find the data\n2. draw it`);
		expect(widgetLines(long, "working")[1]).toBe('  "we want the plot, with error bars." One goal:');
		const lines = widgetLines(GOALS.replace("A plot. Make the plot.", "word ".repeat(200)), "working", 60, { expanded: true });
		expect(lines).toHaveLength(6);
		expect(lines.at(-1)).toBe("  …");
	});

	it("colours through the theme style and fits the width", () => {
		const text = withNote(GOALS.replace("A plot. Make the plot.", "概念 🧪 é ".repeat(40)), "Experiment history ".repeat(60));
		const style = { fg: (color: string, s: string) => `<${color}>${s}</>` };
		const lines = widgetLines(text, "paused", 40, { style });
		expect(lines[0]).toContain("<warning>● goal paused</>");
		expect(lines).toHaveLength(3);
	});
});
