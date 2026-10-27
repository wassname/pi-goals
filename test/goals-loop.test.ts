import { readFileSync, writeFileSync } from "node:fs";
import { stripVTControlCharacters } from "node:util";
import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { section } from "../src/goals.js";
import { DEFAULT_LOOP_STATEMENT } from "../src/prompts.js";
import { GOALS, LOOP, setup } from "./harness.js";

async function ready(h: ReturnType<typeof setup>) {
	await h.commands.get("goals").handler("new plot the data", h.ctx);
	const state = h.branch.findLast(e => e.customType === "pi-goals-single-agent").data;
	writeFileSync(state.file, GOALS);
	await h.tools.get("RequestPlanReview").execute();
	await h.hook("agent_settled");
	return state.file as string;
}

describe("planning and Ready", () => {
	it("keeps user replies verbatim, blocks work tools, and starts one owned scheduler loop only on Ready", async () => {
		const h = setup({ choices: ["Ready"] });
		await h.commands.get("goals").handler("new plot the data", h.ctx);
		const file = h.branch.findLast(e => e.customType === "pi-goals-single-agent").data.file;
		expect(file).toMatch(/\.pi\/goals\/sess-v1\.md$/);
		expect(readFileSync(file, "utf8")).toContain("> /goals new plot the data");
		expect(section(readFileSync(file, "utf8"), "Loop statement")).toBe(DEFAULT_LOOP_STATEMENT);
		writeFileSync(file, GOALS);
		await h.hook("input", { source: "interactive", text: "yes, reuse judge_demos.py" });
		expect(readFileSync(file, "utf8")).toContain("> yes, reuse judge_demos.py");
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
		expect(h.sent.find(m => m.text.startsWith("[pi-goals] The user approved"))?.text).toContain(GOALS);
		expect(await h.hook("tool_call", { toolName: "write", input: { path: "train.py" } })).toBeUndefined();
	});

	it("a second /goals new in the same session makes -v2 and keeps v1", async () => {
		const h = setup();
		await h.commands.get("goals").handler("new first", h.ctx);
		await h.commands.get("goals").handler("clear", h.ctx);
		await h.commands.get("goals").handler("new second", h.ctx);
		expect(h.branch.findLast(e => e.customType === "pi-goals-single-agent").data.file).toMatch(/sess-v2\.md$/);
		expect(readFileSync(`${h.cwd}/.pi/goals/sess-v1.md`, "utf8")).toContain("new first");
	});

	it("a review request is dropped when a later message arrives, and Discuss returns to chat", async () => {
		const h = setup({ choices: ["Discuss in chat"] });
		await h.commands.get("goals").handler("new", h.ctx);
		const file = h.branch.findLast(e => e.customType === "pi-goals-single-agent").data.file;
		writeFileSync(file, GOALS);
		await h.tools.get("RequestPlanReview").execute();
		await h.hook("message_start", { message: { role: "user" } });
		await h.hook("agent_settled");
		expect(h.shown.some(m => m.customType === "goals-draft")).toBe(false);
		await h.tools.get("RequestPlanReview").execute();
		await h.hook("agent_settled");
		expect(h.shown.some(m => m.customType === "goals-draft")).toBe(true);
		expect(h.branch.findLast(e => e.customType === "pi-goals-single-agent").data.phase).toBe("planning");
		expect(h.sent.some(m => m.text.startsWith("/schedule "))).toBe(false);
	});

	it("Cancel starts nothing and keeps the file", async () => {
		const h = setup({ choices: ["Cancel"] });
		const file = await ready(h);
		expect(h.sent.some(m => m.text.startsWith("/schedule "))).toBe(false);
		expect(readFileSync(file, "utf8")).toContain("goal: make the plot");
	});
});

describe("scheduled loop wake", () => {
	it("uses the seeded default until the saved statement changes, including after resume", async () => {
		const h = setup({ choices: ["Ready"] });
		await h.commands.get("goals").handler("new plot the data", h.ctx);
		const file = h.branch.findLast(e => e.customType === "pi-goals-single-agent").data.file;
		const statement = section(readFileSync(file, "utf8"), "Loop statement")!;
		writeFileSync(file, GOALS.replace(LOOP, statement));
		await h.tools.get("RequestPlanReview").execute();
		await h.hook("agent_settled");
		const prompt = h.schedulerReceipt("t1");
		expect((await h.wake("t1", prompt)).text).toContain(DEFAULT_LOOP_STATEMENT);

		writeFileSync(file, GOALS);
		const edited = await h.wake("t1", prompt);
		expect(edited.text).toContain(LOOP);
		expect(edited.text).not.toContain(DEFAULT_LOOP_STATEMENT);
		await h.commands.get("goals").handler("pause", h.ctx);
		await h.commands.get("goals").handler("resume", h.ctx);
		const resumed = await h.wake("t2", h.schedulerReceipt("t2"));
		expect(resumed.text).toContain(LOOP);
		expect(resumed.text).not.toContain(DEFAULT_LOOP_STATEMENT);
	});

	it("repeats complete active blocks and fresh evidence without unrelated sections", async () => {
		const h = setup({ choices: ["Ready"] });
		const file = await ready(h);
		const prompt = h.schedulerReceipt("t1");
		const longNote = "Long note for the full plan. ".repeat(1_000);
		const active = `1. [/] goal: make the plot
   - references: saved_cases.jsonl and postprocess.py
   - subtle failure mode: only the smoke-test cases are corrected
   - completion criteria: corrected post-processing of all 6,149 saved cases
   - discriminator: every saved case has a corrected result
   - verify: just postprocess-all
   - tasks:
     1. [ ] load data
        - details: preserve case IDs
     2. [x] old step
### Evidence
   - results/run.md: "41/6149 processed"; processing is incomplete
   - notes: ${"Case-level evidence. ".repeat(150).trimEnd()}`;
		const second = `2. [/] goal: write the note
   - completion criteria: report the complete dataset, not a sample
### Findings
   - evidence: results/counts.json is still missing`;
		const text = GOALS.replace("A plot.", "A plot with error bars.")
			.replace("## Goals", `## User voice\n\n${longNote}\n\n## Goals`)
			.replace(/1\. \[\/\] goal:[\s\S]*?(?=\n## Log)/, `${active}\n\n${second}\n\n3. [ ] goal: review the results\n   - details: pending-only detail\n4. [✓] goal: prepare the data\n   - evidence: completed-only detail\n\n## Resources\n\nResource-only detail\n`);
		writeFileSync(file, text);
		const out = await h.wake("t1", prompt);
		expect(out.action).toBe("transform");
		expect(out.text).toContain(LOOP);
		expect(out.text).toContain("not a message from the user");
		expect(out.text).toContain("do not switch to another method");
		expect(out.text).toContain("A plot with error bars.");
		expect(out.text).toContain(active);
		expect(out.text).toContain(second);
		expect(out.text).toContain("[ ] goal: review the results");
		expect(out.text).toContain("[✓] goal: prepare the data");
		for (const omitted of [longNote, "pending-only detail", "completed-only detail", "Resource-only detail", "historical detail"]) {
			expect(out.text).not.toContain(omitted);
		}

		writeFileSync(file, text.replace("41/6149 processed", "6149/6149 processed"));
		const updated = await h.wake("t1", prompt);
		expect(updated.text).toContain("6149/6149 processed");
		expect(updated.text).not.toContain('"41/6149 processed"');

		writeFileSync(file, text.replace("[/] goal: make the plot", "[✓] goal: make the plot"));
		const completed = await h.wake("t1", prompt);
		expect(completed.text).toContain("[✓] goal: make the plot");
		expect(completed.text).toContain(second);
		expect(completed.text).not.toContain("saved_cases.jsonl");
	});

	it("keeps open goal status when no goal is marked active", async () => {
		const h = setup({ choices: ["Ready"] });
		const file = await ready(h);
		const prompt = h.schedulerReceipt("t1");
		writeFileSync(file, GOALS.replace("[/] goal:", "[ ] goal:"));
		const out = await h.wake("t1", prompt);
		expect(out.action).toBe("transform");
		expect(out.text).toContain("[ ] goal: make the plot");
		expect(out.text).toContain("[ ] goal: write the note");
		expect(out.text).not.toContain("load data");
	});

	it("puts back Interview entries that an agent write removed, and tells the agent", async () => {
		const h = setup({ choices: ["Ready"] });
		const file = await ready(h);
		await h.hook("input", { source: "interactive", text: "2 the harder direction is more important" });
		await h.hook("tool_call", { toolName: "write", toolCallId: "c1", input: { path: file } });
		writeFileSync(file, `${GOALS}\n## Interview\n`);
		const out = await h.hook("tool_result", { toolName: "write", toolCallId: "c1", input: { path: file }, content: [{ type: "text", text: "ok" }] });
		expect(readFileSync(file, "utf8")).toContain("> 2 the harder direction is more important");
		expect(out.content).toHaveLength(2);
		await h.hook("tool_call", { toolName: "edit", toolCallId: "c2", input: { path: file } });
		expect(await h.hook("tool_result", { toolName: "edit", toolCallId: "c2", input: { path: file }, content: [] })).toBeUndefined();
	});

	it("undoes a write that drops an approved heading", async () => {
		const h = setup({ choices: ["Ready"] });
		const file = await ready(h);
		await h.hook("tool_call", { toolName: "write", toolCallId: "c1", input: { path: file } });
		writeFileSync(file, GOALS.replace("## User-visible result\n\nA plot.\n", ""));
		const out = await h.hook("tool_result", { toolName: "write", toolCallId: "c1", input: { path: file }, content: [] });
		expect(readFileSync(file, "utf8")).toBe(GOALS);
		expect(out.content[0].text).toContain("User-visible result");
	});

	it("turn_end restores Interview after a shell edit, but respects the user's edits between turns", async () => {
		const h = setup({ choices: ["Ready"] });
		const file = await ready(h);
		await h.hook("input", { source: "interactive", text: "keep me" });
		await h.hook("input", { source: "interactive", text: "secret typo" });
		writeFileSync(file, readFileSync(file, "utf8").replace(/### [^\n]+\n\n> keep me\n/, ""));
		await h.hook("turn_end");
		expect(readFileSync(file, "utf8")).toContain("> keep me");
		expect(h.shown.at(-1)?.customType).toBe("goals-structure");
		writeFileSync(file, readFileSync(file, "utf8").replace(/### [^\n]+\n\n> secret typo\n/, ""));
		await h.hook("turn_start");
		await h.hook("turn_end");
		expect(readFileSync(file, "utf8")).not.toContain("secret typo");
	});

	it("keeps user answers given during work verbatim below the Log", async () => {
		const h = setup({ choices: ["Ready"] });
		const file = await ready(h);
		await h.hook("input", { source: "interactive", text: "aws is logged in, gpu queue is free" });
		const text = readFileSync(file, "utf8");
		expect(text.indexOf("> aws is logged in, gpu queue is free")).toBeGreaterThan(text.indexOf("## Log"));
	});

	it("drops wakes from another token and ignores ordinary text", async () => {
		const h = setup({ choices: ["Ready"] });
		await ready(h);
		h.schedulerReceipt("t1");
		expect(await h.wake("t9", "pi-goals-loop:not-ours")).toEqual({ action: "handled" });
		expect(await h.hook("input", { source: "extension", text: "pi-goals-loop:x said in prose" })).toBeUndefined();
	});

	it("pause removes the owned task; later wakes are dropped; resume starts a new loop", async () => {
		const h = setup({ choices: ["Ready"] });
		await ready(h);
		const prompt = h.schedulerReceipt("t1");
		await h.commands.get("goals").handler("pause", h.ctx);
		expect(h.sent.at(-1)?.text).toBe("/schedule-remove t1");
		expect(await h.wake("t1", prompt)).toEqual({ action: "handled" });
		await h.commands.get("goals").handler("resume", h.ctx);
		const second = h.schedulerReceipt("t2");
		expect(second).not.toBe(prompt);
		expect((await h.wake("t2", second)).action).toBe("transform");
	});

	it("stops the loop when no goals remain", async () => {
		const h = setup({ choices: ["Ready"] });
		const file = await ready(h);
		const prompt = h.schedulerReceipt("t1");
		writeFileSync(file, GOALS.replace("[/] goal: make", "[✓] goal: make").replace("[ ] goal: write", "[-] goal: write"));
		expect(await h.wake("t1", prompt)).toEqual({ action: "handled" });
		expect(h.sent.at(-1)?.text).toBe("/schedule-remove t1");
	});
});

describe("pi-tasks in goal mode", () => {
	it("removes TaskCreate while working, keeps TaskUpdate, and restores TaskCreate on pause", async () => {
		const h = setup({ choices: ["Ready"] });
		expect(h.activeTools()).toContain("TaskCreate");
		await ready(h);
		expect(h.activeTools()).not.toContain("TaskCreate");
		expect(h.activeTools()).toContain("TaskUpdate");
		expect(h.sent.at(-1)!.text).toContain("TaskCreate is off in goal mode");
		await h.commands.get("goals").handler("pause", h.ctx);
		expect(h.activeTools()).toContain("TaskCreate");
	});
});

describe("widget rendering", () => {
	it.each(["tui", "rpc"])("shows goal titles/status and open tasks of the [/] goal only, excludes evidence, and fits the width (%s)", async (mode) => {
		const h = setup({ choices: ["Ready"] });
		h.ctx.mode = mode;
		const file = await ready(h);
		const text = GOALS.replace("make the plot", "概念 🧪 é ".repeat(100))
			.replace("load data", "Experiment history ".repeat(300))
			.replace("   - tasks:", "   - evidence: 48/89 vs 37/89\n   - tasks:");
		writeFileSync(file, text);
		await h.hook("session_start");
		const component = mode === "tui" ? h.ctx.widget() : undefined;
		for (const width of mode === "tui" ? [20, 80, 160, 20] : [100]) {
			const lines = component ? component.render(width) : h.ctx.widget;
			expect(lines).toHaveLength(5);
			expect(stripVTControlCharacters(lines[0])).toMatch(/^◼ G1:.*…$/);
			expect(stripVTControlCharacters(lines[1])).toMatch(/^ {4}\[ \] Experiment.*…$/);
			expect(stripVTControlCharacters(lines[2])).toBe("    … 1 done");
			expect(lines[3]).toBe("◻ G2: write the note");
			expect(lines.join("\n")).not.toMatch(/48\/89|old step|◦/);
			for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
		}
		expect(readFileSync(file, "utf8")).toBe(text);
	});
});

describe("context after compaction and resume", () => {
	it("sends the whole goals file once after compaction, including Log", async () => {
		const h = setup({ choices: ["Ready"] });
		await ready(h);
		await h.hook("before_agent_start");
		await h.hook("session_compact");
		const retry = await h.hook("context", { messages: [] });
		expect(retry.messages.at(-1).content[0].text).toContain("historical detail");
		expect(await h.hook("context", { messages: [] })).toBeUndefined();
	});

	it("restores this session's goals on resume and ignores another session's state", async () => {
		const h = setup({ choices: ["Ready"] });
		await ready(h);
		await h.hook("session_start");
		expect((await h.hook("before_agent_start")).message.content).toContain(LOOP);
		expect(h.ctx.widget.slice(0, 4)).toEqual(["◼ G1: make the plot", "    [ ] load data", "    … 1 done", "◻ G2: write the note"]);
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
