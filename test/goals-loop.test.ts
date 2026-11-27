import { readFileSync, writeFileSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { section, split } from "../src/goals.js";
import piGoals, { SUBAGENT_COMPLETION_ACTION } from "../src/index.js";
import { KEEP_GOING } from "../src/prompts.js";
import { GOALS, LOOP, setup, withNote } from "./harness.js";

const state = (h: ReturnType<typeof setup>) => h.branch.findLast(e => e.customType === "pi-goals-single-agent").data;
async function ready(h: ReturnType<typeof setup>, text = GOALS) {
	await h.commands.get("goals").handler("new plot the data", h.ctx);
	writeFileSync(state(h).file, text);
	await h.tools.get("RequestPlanReview").execute();
	await h.hook("agent_settled");
	return state(h).file as string;
}

describe("planning and Ready", () => {
	it("blocks work tools, leaves the file to the agent, and starts one owned scheduler loop only on Ready", async () => {
		const h = setup({ choices: ["Ready"] });
		await h.commands.get("goals").handler("new plot the data", h.ctx);
		const file = state(h).file;
		expect(file).toMatch(/\.pi\/goals\/sess-v1\.md$/);
		writeFileSync(file, GOALS);
		await h.hook("input", { source: "interactive", text: "yes, reuse judge_demos.py" });
		expect(readFileSync(file, "utf8")).toBe(GOALS);
		expect(await h.hook("tool_call", { toolName: "write", input: { path: "train.py" } })).toMatchObject({ block: true });
		expect(await h.hook("tool_call", { toolName: "bash", input: { command: "head data.csv" } })).toBeUndefined();
		expect(await h.hook("tool_call", { toolName: "write", input: { path: file } })).toBeUndefined();
		expect(await h.hook("tool_call", { toolName: "write", input: { path: "slop/briefs/oracle.md" } })).toBeUndefined();
		expect(await h.hook("tool_call", { toolName: "write", input: { path: "slop/../train.py" } })).toMatchObject({ block: true });
		expect(await h.hook("tool_call", { toolName: "edit", input: { path: "slopx/a.md" } })).toMatchObject({ block: true });
		expect(h.sent.some(m => m.text.startsWith("/schedule "))).toBe(false);

		await h.tools.get("RequestPlanReview").execute();
		await h.hook("agent_settled");
		expect(h.sent.filter(m => m.text.startsWith("/schedule ")).length).toBe(1);
		const approved = h.sent.find(m => m.text.startsWith("[pi-goals] The user approved"))!.text;
		for (const kept of ["# Title\n\n## Goal\n\nA plot. Make the plot.", "score-placeholder", LOOP, "): /goals new plot the data", "): yes, reuse judge_demos.py"]) expect(approved).toContain(kept);
		expect(await h.hook("tool_call", { toolName: "write", input: { path: "train.py" } })).toBeUndefined();
	});

	it("refuses a review request for an incomplete page or one longer than a page, and tells the agent", async () => {
		const h = setup({ choices: ["Ready"] });
		await h.commands.get("goals").handler("new", h.ctx);
		const review = () => h.tools.get("RequestPlanReview").execute();
		writeFileSync(state(h).file, GOALS.replace("## Resume here\n", ""));
		await expect(review()).rejects.toThrow(/Resume here/);
		// What the user reads has its own limit, and packing the same words into fewer lines does not help.
		writeFileSync(state(h).file, GOALS.replace("Make the plot.", Array.from({ length: 10 }, (_, n) => `- ${`detail ${n} `.repeat(30)}`).join("\n")));
		await expect(review()).rejects.toThrow(/have 6\d\d words \(at most 500/);
		// Notes are for the agent, with a looser limit on the whole page.
		const notes = (words: number) => GOALS.replace("- could look done", `- ${"note ".repeat(words)}\n- could look done`);
		writeFileSync(state(h).file, notes(600));
		await review();
		await h.hook("message_start", { message: { role: "user" } });
		writeFileSync(state(h).file, notes(1300));
		await expect(review()).rejects.toThrow(/has 13\d\d \(at most 1200\)/);
		await h.hook("agent_settled");
		expect(state(h).phase).toBe("planning");
	});

	it("shows the agent the user's own edit to the draft, once, and says their text stands", async () => {
		const h = setup();
		await h.commands.get("goals").handler("new", h.ctx);
		const file = state(h).file;
		expect(await h.hook("before_agent_start")).toBeUndefined();
		expect(await h.edit(file, GOALS)).toBeUndefined();
		expect(await h.hook("before_agent_start")).toBeUndefined();
		writeFileSync(file, GOALS.replace("A plot. Make the plot.", "No: one figure, log axis, error bars."));
		const shown = (await h.hook("before_agent_start")).message.content as string;
		for (const kept of ["The user edited the goals file. Their text stands", "No: one figure, log axis, error bars.", "[pi-goals: planning]"]) expect(shown).toContain(kept);
		expect(await h.hook("before_agent_start")).toBeUndefined();
	});

	it("a second /goals new in the same session makes -v2 and keeps v1", async () => {
		const h = setup();
		await h.commands.get("goals").handler("new first", h.ctx);
		writeFileSync(state(h).file, GOALS);
		await h.commands.get("goals").handler("clear", h.ctx);
		await h.commands.get("goals").handler("new second", h.ctx);
		expect(state(h).file).toMatch(/sess-v2\.md$/);
		expect(readFileSync(`${h.cwd}/.pi/goals/sess-v1.md`, "utf8")).toBe(GOALS);
	});

	it("a review request is dropped when a later message arrives, and Discuss returns to chat", async () => {
		const h = setup({ choices: ["Discuss in chat"] });
		await h.commands.get("goals").handler("new", h.ctx);
		writeFileSync(state(h).file, GOALS);
		await h.tools.get("RequestPlanReview").execute();
		await h.hook("message_start", { message: { role: "user" } });
		await h.hook("agent_settled");
		expect(h.shown.some(m => m.customType === "goals-draft")).toBe(false);
		await h.tools.get("RequestPlanReview").execute();
		await h.hook("agent_settled");
		expect(h.shown.some(m => m.customType === "goals-draft")).toBe(true);
		expect(state(h).phase).toBe("planning");
		expect(h.sent.some(m => m.text.startsWith("/schedule "))).toBe(false);
	});

	it("Cancel starts nothing and keeps the file", async () => {
		const h = setup({ choices: ["Cancel"] });
		await ready(h);
		expect(h.sent.some(m => m.text.startsWith("/schedule "))).toBe(false);
		expect(state(h).file).toBeUndefined();
		expect(readFileSync(`${h.cwd}/.pi/goals/sess-v1.md`, "utf8")).toBe(GOALS);
	});
});

describe("scheduled loop wake", () => {
	it("sends the loop statement, aim, goal and the agent's note as they are in the file now", async () => {
		const h = setup({ choices: ["Ready"] });
		const file = await ready(h);
		const prompt = h.schedulerReceipt("t1");
		const first = await h.wake("t1", prompt, "3h");
		expect(first.action).toBe("transform");
		for (const kept of [LOOP, "not a message from the user", "every 3h", "t1", "manage_scheduled_task", "A plot. Make the plot.", "(empty: write it now)"]) expect(first.text).toContain(kept);
		for (const left of ["score-placeholder", "without error bars"]) expect(first.text).not.toContain(left);

		writeFileSync(file, withNote(GOALS.replace(LOOP, "Edited by the user."), "Fitting the bars; job 12 wakes me."));
		const second = await h.wake("t1", prompt);
		for (const kept of ["Edited by the user.", "Fitting the bars; job 12 wakes me."]) expect(second.text).toContain(kept);
		expect(second.text).not.toContain(LOOP);
	});

	it("says to keep going until the user stops it, unless the page carries its own Loop statement", async () => {
		const h = setup({ choices: ["Ready"] });
		const file = await ready(h, GOALS.replace(`## Loop statement\n\n${LOOP}\n\n`, ""));
		const text = (await h.wake("t1", h.schedulerReceipt("t1"))).text as string;
		expect(text).toContain(KEEP_GOING);
		expect(text.indexOf("A plot. Make the plot.")).toBeLessThan(text.indexOf(KEEP_GOING));
		writeFileSync(file, GOALS);
		await h.hook("before_agent_start");
		const custom = (await h.wake("t1", h.schedulerReceipt("t1"))).text as string;
		expect(custom).toContain(LOOP);
		expect(custom).not.toContain(KEEP_GOING);
	});

	it("warns and skips a reminder when the file has no ## Goal, without pausing work", async () => {
		const h = setup({ choices: ["Ready"] });
		const file = await ready(h);
		const prompt = h.schedulerReceipt("t1");
		writeFileSync(file, GOALS.replace("## Goal\n", "## Goals\n"));
		expect(await h.wake("t1", prompt)).toEqual({ action: "handled" });
		expect(h.shown.at(-1)?.content).toMatch(/Scheduler warning:.*## Goal/);
		expect(state(h).phase).toBe("working");
	});

	it("drops wakes from another token and ignores ordinary text", async () => {
		const h = setup({ choices: ["Ready"] });
		await ready(h);
		h.schedulerReceipt("t1");
		expect(await h.wake("t9", "pi-goals-loop:not-mine")).toEqual({ action: "handled" });
		expect(await h.hook("input", { source: "extension", text: "ordinary scheduled prompt" })).toBeUndefined();
	});

	it("pause removes the owned task; later wakes are dropped; resume starts a new loop", async () => {
		const h = setup({ choices: ["Ready"] });
		await ready(h);
		const prompt = h.schedulerReceipt("t1");
		await h.commands.get("goals").handler("pause", h.ctx);
		expect(h.sent.at(-1)?.text).toBe("/schedule-remove t1");
		expect(await h.wake("t1", prompt)).toEqual({ action: "handled" });
		await h.commands.get("goals").handler("resume", h.ctx);
		expect(h.sent.filter(m => m.text.startsWith("/schedule ")).length).toBe(2);
		expect(await h.wake("t2", h.schedulerReceipt("t2"))).toMatchObject({ action: "transform" });
	});
});

describe("the approved page", () => {
	it("undoes an agent edit to the page during an automated run, keeps its note, and tells the agent", async () => {
		const h = setup({ choices: ["Ready"] });
		const file = await ready(h);
		await h.hook("before_agent_start");
		const out = await h.edit(file, withNote(GOALS.replace(LOOP, `${LOOP}\nNothing else runs until he picks.`), "Waiting for the user."));
		const text = readFileSync(file, "utf8");
		expect(split(text).page).toBe(split(GOALS).page);
		expect(section(text, "Resume here")).toBe("Waiting for the user.");
		expect(out.content[1].text).toMatch(/undid that part and kept your notes/);
		// A note that is not short labelled lines draws one request to rewrite it; a labelled note passes without comment.
		expect(out.content[2].text).toMatch(/hard to read there.*"Now:"/s);
		expect(await h.edit(file, withNote(GOALS, "Saw: 8 steps did not converge.\nNow: rerunning at 40 steps.\nIf it fails: check a planted state."))).toBeUndefined();
		const paragraph = await h.edit(file, withNote(GOALS, `Now: ${"deliverable 1 started with many parameters, ".repeat(8)}`));
		expect(paragraph.content.at(-1).text).toMatch(/hard to read there/);
		expect((await h.wake("t1", h.schedulerReceipt("t1"))).text).toMatch(/hard to read there/);
	});

	it("undoes the edit even when the user's own message asked for it; /goals replan lets the agent draft the change for Ready", async () => {
		const h = setup({ choices: ["Ready", "Ready"] });
		const file = await ready(h);
		h.schedulerReceipt("t1");
		const edited = GOALS.replace("Make the plot.", "Make the plot with a log axis.");
		await h.hook("input", { source: "interactive", text: "update the goal: log axis" });
		await h.hook("before_agent_start");
		expect((await h.edit(file, edited)).content.at(-1).text).toMatch(/\/goals replan/);
		expect(readFileSync(file, "utf8")).toBe(GOALS);

		await h.commands.get("goals").handler("replan", h.ctx);
		expect(state(h).phase).toBe("planning");
		expect(h.sent.some(m => m.text === "/schedule-remove t1")).toBe(true);
		expect(h.sent.at(-1)?.text).toContain("reopened the approved page");
		expect(await h.edit(file, edited)).toBeUndefined();
		expect(await h.hook("tool_call", { toolName: "write", input: { path: "train.py" } })).toMatchObject({ block: true });
		await h.tools.get("RequestPlanReview").execute();
		await h.hook("agent_settled");
		expect(state(h).phase).toBe("working");
		expect(h.sent.findLast(m => m.text.startsWith("[pi-goals] The user approved"))!.text).toContain("log axis");
	});

	it("takes a change made outside the agent's edit tools as the user's and re-sends the file", async () => {
		const h = setup({ choices: ["Ready"] });
		const file = await ready(h);
		await h.hook("before_agent_start");
		writeFileSync(file, GOALS.replace("Make the plot.", "Make two plots."));
		await h.hook("turn_end");
		const during = h.shown.findLast(m => m.customType === "goals-context")!.content;
		expect(during).toContain("not through a tool call of yours");
		expect(during).toContain("Make two plots.");
		await h.hook("turn_end");
		expect(h.shown.filter(m => m.customType === "goals-context")).toHaveLength(1);
		// Between runs: sent with the next prompt.
		writeFileSync(file, GOALS.replace("Make the plot.", "Make three plots."));
		expect((await h.hook("before_agent_start")).message.content).toContain("Make three plots.");
		expect(await h.hook("before_agent_start")).toBeUndefined();
	});

	it("treats a shell command that names the goals file as the agent's edit: undone while working, and not called the user's while planning", async () => {
		const h = setup({ choices: ["Ready"] });
		await h.commands.get("goals").handler("new", h.ctx);
		const file = state(h).file as string;
		const python = `python3 - <<'E'\np='.pi/goals/sess-v1.md'; s=open(p).read(); open(p,'w').write(s)\nE`;
		expect(await h.shell(python, file, GOALS)).toBeUndefined();
		await h.hook("turn_end");
		expect(await h.hook("before_agent_start")).toBeUndefined();
		expect(h.shown.some(m => m.customType === "goals-context")).toBe(false);

		await h.tools.get("RequestPlanReview").execute();
		await h.hook("agent_settled");
		await h.hook("before_agent_start");
		const out = await h.shell(`sed -i 's/Make the plot/Make any plot/' ${file}`, file, withNote(GOALS.replace("Make the plot.", "Make any plot."), "Now: changed the goal."));
		expect(out.content.at(-1).text).toMatch(/undid that part and kept your notes/);
		expect(split(readFileSync(file, "utf8")).page).toBe(split(GOALS).page);
		expect(section(readFileSync(file, "utf8"), "Resume here")).toBe("Now: changed the goal.");
		// A command that does not name the file is not an edit of it.
		expect(await h.shell("ls -la", file, readFileSync(file, "utf8"))).toBeUndefined();
	});

	it("sends back only the first lines of an overgrown note and none of the rest of the appendix", async () => {
		const h = setup({ choices: ["Ready"] });
		const file = await ready(h);
		const prompt = h.schedulerReceipt("t1");
		await h.hook("before_agent_start");
		const long = withNote(GOALS, Array.from({ length: 20 }, (_, n) => `22:${n} ran step ${n}`).join("\n")) + "\n## OVERNIGHT\n\nNothing else runs until he picks.\n";
		const out = await h.edit(file, long);
		expect(out.content.at(-1).text).toMatch(/20 lines.*first 15/s);
		expect(readFileSync(file, "utf8")).toBe(long);
		const wake = (await h.wake("t1", prompt)).text as string;
		expect(wake).toContain("ran step 14");
		expect(wake).not.toContain("ran step 15");
		expect(wake).toContain("5 more lines are not sent");
		await h.hook("session_compact");
		const resent = (await h.hook("context", { messages: [] })).messages.at(-1).content[0].text as string;
		expect(resent).toContain("ran step 14");
		expect(resent).not.toMatch(/ran step 15|OVERNIGHT|until he picks/);
	});
});

describe("pi-subagents completion notices in goal mode", () => {
	it("removes the report-or-continue text while working, and leaves other notices and other phases alone", async () => {
		const h = setup({ choices: ["Ready"] });
		const completed = (customType: string, details: unknown) => ({ role: "custom", customType, details, content: `Background task completed: **worker**\n\nresult text\n\nParent action: ${SUBAGENT_COMPLETION_ACTION}` });
		const done = completed("subagent-notify", { runs: [{ status: "completed" }] });
		const child = completed("subagent-incremental-child-notify", { outcome: "completed" });
		const failed = completed("subagent-notify", { runs: [{ status: "completed" }, { status: "failed" }] });
		const reminder = { role: "custom", customType: "subagent-completion-unanswered", content: `A notice was not answered. ${SUBAGENT_COMPLETION_ACTION}` };
		const other = { role: "user", content: [{ type: "text", text: "hello" }] };
		expect(await h.hook("context", { messages: [done] })).toBeUndefined();
		await ready(h);
		await h.hook("before_agent_start");
		const out = (await h.hook("context", { messages: [done, child, failed, reminder, other] })).messages;
		expect(out[0].content).toBe("Background task completed: **worker**\n\nresult text");
		expect(out[1].content).toBe("Background task completed: **worker**\n\nresult text");
		expect(out[2]).toBe(failed);
		expect(out[3].content).toBe("A notice was not answered.");
		expect(out[4]).toBe(other);
		expect(await h.hook("context", { messages: [other] })).toBeUndefined();
	});
});

describe("pi-tasks beside the goal", () => {
	it("leaves TaskCreate on while working, and gives it back to a session that an older version reduced", async () => {
		const h = setup({ choices: ["Ready"] });
		await ready(h);
		expect(h.activeTools()).toContain("TaskCreate");
		h.pi.setActiveTools(["read", "bash", "TaskUpdate"]);
		h.branch.push({ type: "custom", customType: "pi-goals-single-agent", data: { ...state(h), taskCreateOff: true } });
		await h.hook("session_start");
		expect(h.activeTools()).toContain("TaskCreate");
		expect(state(h).taskCreateOff).toBeUndefined();
	});
});

describe("widget rendering", () => {
	it.each(["tui", "rpc"])("shows the status, title and note, and fits the width (%s)", async (mode) => {
		const h = setup({ choices: ["Ready"] });
		h.ctx.mode = mode;
		const file = await ready(h);
		writeFileSync(file, withNote(GOALS.replace("A plot. Make the plot.", "概念 🧪 é ".repeat(100)), "Experiment history ".repeat(300)));
		await h.hook("session_start");
		const component = mode === "tui" ? h.ctx.widget(undefined, { fg: (_color: string, s: string) => s }) : undefined;
		for (const width of mode === "tui" ? [20, 80, 160, 20] : [100]) {
			const lines = component ? component.render(width) : h.ctx.widget;
			expect(lines).toHaveLength(3);
			expect(lines[0]).toMatch(/^● goal working · \.p/);
			expect(lines[1]).toMatch(/^ {2}概/);
			for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
		}
		expect(h.ctx.status).toBe("goal working");
		writeFileSync(file, withNote(GOALS, "Needs you: log or linear axis? I use log until you say."));
		await h.hook("turn_end");
		expect(h.ctx.status).toBe("goal working · 1 needs you");
	});

	it("a click or Pi's ctrl+o (tools expanded) flips the widget between the first line of the note and all of it", async () => {
		const h = setup({ choices: ["Ready"] });
		h.ctx.mode = "tui";
		const file = await ready(h);
		writeFileSync(file, withNote(GOALS, "Fitting the bars.\nIf it fails: rerun at 40 steps."));
		await h.hook("session_start");
		const widget = h.ctx.widget(undefined, { fg: (_color: string, s: string) => s });
		const collapsed = ["● goal working · .pi/goals/sess-v1.md · click to expand", "  A plot. Make the plot.", "  → Fitting the bars."];
		const expanded = ["● goal working · click to collapse", `  ${file}`, "  A plot. Make the plot.", "", "  Fitting the bars.", "  If it fails: rerun at 40 steps."];
		expect(widget.render(100)).toEqual(collapsed);
		expect(widget.handleMouse({ type: "move", button: "none" })).toBeUndefined();
		expect(widget.handleMouse({ type: "click", button: "left" })).toEqual({ handled: true });
		expect(widget.render(100)).toEqual(expanded);
		h.ctx.toolsExpanded = true; // ctrl+o
		expect(widget.render(100)).toEqual(collapsed);
	});
});

describe("context after compaction and resume", () => {
	it("sends the whole file and the user's five newest messages once after compaction", async () => {
		const h = setup({ choices: ["Ready"] });
		const file = await ready(h);
		writeFileSync(file, withNote(GOALS, "Fitting the bars."));
		for (let n = 1; n <= 8; n++) await h.hook("input", { source: "interactive", text: `user message ${n}.` });
		await h.hook("input", { source: "interactive", text: `${"x".repeat(9000)}\nlast line of a long paste` });
		await h.hook("before_agent_start");
		await h.hook("session_compact");
		const retry = await h.hook("context", { messages: [] });
		const text = retry.messages.at(-1).content[0].text as string;
		for (const kept of [LOOP, "A plot.", "Make the plot.", "Fitting the bars.", "user message 8.", "user message 5.", "middle cut", "last line of a long paste"]) expect(text).toContain(kept);
		expect(text).not.toContain("user message 4.");
		expect(text.indexOf("user message 8.")).toBeGreaterThan(text.indexOf("## Evidence"));
		expect(text.length).toBeLessThan(8000);
		expect(await h.hook("context", { messages: [] })).toBeUndefined();
	});

	it("while paused, sends nothing at pause and marks the file paused when it is re-sent after compaction", async () => {
		const h = setup({ choices: ["Ready"] });
		await ready(h);
		const sent = h.sent.length;
		await h.commands.get("goals").handler("pause", h.ctx);
		expect(h.sent.slice(sent).filter((m) => !m.text.startsWith("/schedule-remove"))).toEqual([]);
		await h.hook("session_compact");
		const text = (await h.hook("context", { messages: [] })).messages.at(-1).content[0].text as string;
		expect(text.startsWith("[pi-goals: paused]")).toBe(true);
		expect(text).toContain("Make the plot.");
		expect(text).not.toContain("Continue the goal");
	});

	it("restores this session's goal on resume and ignores another session's state", async () => {
		const h = setup({ choices: ["Ready"] });
		await ready(h);
		await h.hook("session_start");
		expect((await h.hook("before_agent_start")).message.content).toContain(LOOP);
		expect(h.ctx.widget).toEqual(["● goal working · .pi/goals/sess-v1.md · click to expand", "  A plot. Make the plot."]);
		h.branch.push({ type: "custom", customType: "pi-goals-single-agent", data: { owner: "other", phase: "working", file: "x", judge: true } });
		await h.hook("session_start");
		expect(h.notes.at(-1)).toContain("forked from one with goals x");
		const shown = h.notes.length;
		await h.hook("session_start");
		expect(h.notes.length).toBe(shown);
		expect(await h.hook("before_agent_start")).toBeUndefined();
		expect(h.ctx.widget).toBeUndefined();
	});
});

describe("a goals file from before the one-page format", () => {
	it("is detached at session start, left unchanged, and its reminder removed", async () => {
		const h = setup({ choices: ["Ready"] });
		const file = await ready(h);
		h.schedulerReceipt("t1");
		const old = "# Old\n\nAim.\n\n## Goals\n\n1. [/] goal: make the plot\n   - tasks:\n     1. [ ] load data\n\n## Loop statement\n\nKeep going.\n\n## Log\n\n- entry\n\n## Interview\n";
		writeFileSync(file, old);
		await h.hook("session_start");
		expect(h.notes.at(-1)).toMatch(/older format.*\/goals new/s);
		expect(state(h)).toMatchObject({ phase: null });
		expect(state(h).file).toBeUndefined();
		expect(h.sent.at(-1)?.text).toBe("/schedule-remove t1");
		expect(readFileSync(file, "utf8")).toBe(old);
		expect(await h.hook("before_agent_start")).toBeUndefined();
		expect(await h.settle()).toBeUndefined();
	});
});

describe("loading", () => {
	it("registers the command, both tools and the stop boundary", () => {
		const names: string[] = [];
		const pi = { on: (name: string) => names.push(name), registerCommand: (name: string) => names.push(`/${name}`), registerTool: (tool: { name: string }) => names.push(tool.name) };
		piGoals(pi as unknown as ExtensionAPI);
		for (const name of ["/goals", "RequestPlanReview", "CompleteGoal", "agent_before_settle", "input", "tool_result"]) expect(names).toContain(name);
	});
});
