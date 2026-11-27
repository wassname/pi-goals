import { describe, expect, it } from "vitest";
import { appendEvidence, dialogue, keepPage, lastLines, lineCount, note, section, split, title, view, widgetLines } from "../src/goals.js";
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
		expect(lineCount(split(goalsTemplate).page)).toBeLessThan(40);
		for (const name of ["Goal", "Result mock-up", "Notes", "Loop statement", "Resume here", "Evidence"]) expect(section(goalsTemplate, name)).toBeDefined();
		expect(goalsTemplate.indexOf("## Goal")).toBeLessThan(goalsTemplate.indexOf("## Result mock-up"));
		expect(goalsTemplate.indexOf("## Result mock-up")).toBeLessThan(goalsTemplate.indexOf("## Notes"));
	});

	it("re-sends the page, the first lines of the note and the newest evidence, and none of the rest of the appendix", () => {
		const lines = (n: number, word: string) => Array.from({ length: n }, (_, i) => `- ${word} ${i}`).join("\n");
		const text = `${withNote(GOALS, lines(18, "step")).trimEnd()}\n\n${lines(25, "result")}\n\n## OVERNIGHT\n\nNothing else runs until he picks.\n`;
		expect(note(text).split("\n")).toHaveLength(16);
		const sent = view(text);
		for (const kept of ["A plot. Make the plot.", "step 14", "3 more lines are not sent", "5 earlier lines are in the file", "result 24", "result 5"]) expect(sent).toContain(kept);
		expect(sent).not.toMatch(/step 15|result 4\n|OVERNIGHT|until he picks/);
		expect(view(GOALS)).toContain("## Resume here");
	});
});

describe("what the user typed, for a reader who was not there", () => {
	it("shows each message after the last lines of the agent message it answered", () => {
		const before = lastLines("I wrote file.m.\n\nIt plots the curve in pink.\nShall I go on?\n", 2);
		expect(dialogue([{ at: "2026-01-01 10:00", text: "make a plot" }, { at: "2026-01-01 10:05", text: "I don't like it in pink.\nBrown please.", before }])).toBe(
			"User (2026-01-01 10:00): make a plot\n\nAgent: … It plots the curve in pink.\nAgent: Shall I go on?\nUser (2026-01-01 10:05): I don't like it in pink.\n  Brown please.");
		expect(dialogue([])).toBe("");
	});

	it("keeps the first and last 1,000 lines of a long history, and the two ends of a long message", () => {
		const many = Array.from({ length: 1500 }, (_, n) => ({ at: "t", text: `message ${n}` }));
		const lines = dialogue(many).split("\n");
		expect(lines).toHaveLength(2000);
		expect(lines[0]).toBe("User (t): message 0");
		expect(lines[1000]).toBe("… (1000 lines of the middle of the conversation cut) …");
		expect(lines.at(-1)).toBe("User (t): message 1499");
		const paste = dialogue([{ at: "t", text: Array.from({ length: 100 }, (_, n) => `row ${n} ${"y".repeat(500)}`).join("\n") }]).split("\n");
		expect(paste).toHaveLength(61);
		expect(paste[30]).toBe("  … (40 lines cut) …");
		expect(paste[0]).toHaveLength("User (t): ".length + 301);
		expect(paste.at(-1)).toMatch(/^ {2}row 99 y+…$/);
	});
});

describe("widget", () => {
	it("shows the status and title, then the first line of the note; expanded, the whole note", () => {
		expect(widgetLines(GOALS, "working")).toEqual(["● goal working · Title"]);
		const text = withNote(GOALS, "Fitting the bars.\nIf it fails: rerun at 40 steps.");
		expect(widgetLines(text, "working")).toEqual(["● goal working · Title · click to expand", "  → Fitting the bars."]);
		expect(widgetLines(text, "accepted", 100, { expanded: true })).toEqual(["● goal accepted · Title · click to collapse", "  Fitting the bars.", "  If it fails: rerun at 40 steps."]);
	});

	it("colours through the theme style and fits the width", () => {
		const text = withNote(GOALS.replace("# Title", `# ${"概念 🧪 é ".repeat(40)}`), "Experiment history ".repeat(60));
		const style = { fg: (color: string, s: string) => `<${color}>${s}</>` };
		const lines = widgetLines(text, "paused", 40, { style });
		expect(lines[0]).toContain("<warning>● goal paused</>");
		expect(lines).toHaveLength(2);
	});
});
