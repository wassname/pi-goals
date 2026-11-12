import { readFileSync, writeFileSync } from "node:fs";
import { stripVTControlCharacters } from "node:util";
import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import { section } from "../src/goals.js";
import { SUBAGENT_COMPLETION_ACTION } from "../src/index.js";
import { DEFAULT_LOOP_STATEMENT } from "../src/prompts.js";
import { GOALS, LOOP, setup } from "./harness.js";

async function ready(h: ReturnType<typeof setup>, text = GOALS) {
	await h.commands.get("goals").handler("new plot the data", h.ctx);
	const state = h.branch.findLast(e => e.customType === "pi-goals-single-agent").data;
	writeFileSync(state.file, text);
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
		const approved = h.sent.find(m => m.text.startsWith("[pi-goals] The user approved"))!.text;
		for (const kept of ["# Title\n\nA plot.", "1. [/] goal: make the plot", "1. [ ] load data", "(1 finished task left out)", LOOP]) expect(approved).toContain(kept);
		expect(approved).not.toContain("old step");
		expect(approved).toContain("> yes, reuse judge_demos.py");
		expect(approved).not.toContain("historical detail");
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

	it("shows the interval, goal and status, and only open tasks of active goals; field details stay in the file", async () => {
		const h = setup({ choices: ["Ready"] });
		const file = await ready(h);
		const prompt = h.schedulerReceipt("t1");
		const active = `1. [/] goal: make the plot
   - references: saved_cases.jsonl and postprocess.py
   - subtle failure mode: only the smoke-test cases are corrected
   - tasks:
     1. [ ] load data
        - details: preserve case IDs
     2. [x] old step
   - evidence:
     - results/run.md: "41/6149 processed"`;
		const text = GOALS.replace("A plot.", "A plot with error bars.")
			.replace(/1\. \[\/\] goal:[\s\S]*?(?=\n\n## Loop statement)/, `${active}\n2. [ ] goal: write the note\n   - tasks:\n     1. [ ] draft it\n3. [✓] goal: prepare the data\n`);
		writeFileSync(file, text);
		const out = await h.wake("t1", prompt, "3h");
		expect(out.action).toBe("transform");
		for (const kept of [LOOP, "not a message from the user", "every 3h", "t1", "manage_scheduled_task", "A plot with error bars.", "[/] goal: make the plot", "[ ] goal: write the note", "[✓] goal: prepare the data", "G1 1. [ ] load data"]) {
			expect(out.text).toContain(kept);
		}
		for (const omitted of ["saved_cases.jsonl", "only the smoke-test cases", "preserve case IDs", "old step", "41/6149", "draft it", "historical detail"]) {
			expect(out.text).not.toContain(omitted);
		}
	});

	it("lists [?] tasks after the agent's own open tasks", async () => {
		const h = setup({ choices: ["Ready"] });
		const file = await ready(h);
		const prompt = h.schedulerReceipt("t1");
		writeFileSync(file, GOALS.replace("     1. [ ] load data", "     1. [?] Log or linear y axis?\n     3. [ ] load data"));
		const text = (await h.wake("t1", prompt)).text as string;
		expect(text).toContain("G1 1. [?] Log or linear y axis?");
		expect(text.indexOf("[?] Log or linear")).toBeGreaterThan(text.indexOf("[ ] load data"));
	});

	it("orders open tasks by time since their text changed, and keeps ages across a restart", async () => {
		vi.useFakeTimers({ now: new Date("2026-01-01T00:00:00Z") });
		try {
			const h = setup({ choices: ["Ready"] });
			const file = await ready(h);
			const prompt = h.schedulerReceipt("t1");
			const text = GOALS.replace("     2. [x] old step", "     2. [ ] plot it\n     3. [x] old step");
			writeFileSync(file, text);
			await h.wake("t1", prompt);
			vi.advanceTimersByTime(3 * 3_600_000);
			writeFileSync(file, text.replace("2. [ ] plot it", "2. [/] plot it"));
			const out = (await h.wake("t1", prompt)).text as string;
			expect(out).toContain("load data · unchanged 3 h");
			expect(out).toContain("plot it · unchanged under 1 h");
			expect(out.indexOf("load data")).toBeLessThan(out.indexOf("plot it"));

			await h.hook("session_start");
			vi.advanceTimersByTime(2 * 3_600_000);
			expect((await h.wake("t1", prompt)).text).toContain("load data · unchanged 5 h");
		} finally { vi.useRealTimers(); }
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

	it("lets a file approved with ## User-visible result move its aim under the title", async () => {
		const h = setup({ choices: ["Ready"] });
		const file = await ready(h, GOALS.replace("A plot.", "## User-visible result\n\nA plot."));
		await h.hook("tool_call", { toolName: "write", toolCallId: "c1", input: { path: file } });
		writeFileSync(file, GOALS);
		expect(await h.hook("tool_result", { toolName: "write", toolCallId: "c1", input: { path: file }, content: [] })).toBeUndefined();
		expect(readFileSync(file, "utf8")).toBe(GOALS);
	});

	it("undoes a write that drops an approved heading", async () => {
		const h = setup({ choices: ["Ready"] });
		const file = await ready(h);
		await h.hook("tool_call", { toolName: "write", toolCallId: "c1", input: { path: file } });
		writeFileSync(file, GOALS.replace(`## Loop statement\n\n${LOOP}\n`, ""));
		const out = await h.hook("tool_result", { toolName: "write", toolCallId: "c1", input: { path: file }, content: [] });
		expect(readFileSync(file, "utf8")).toBe(GOALS);
		expect(out.content[0].text).toContain("Loop statement");
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

	it("does not warn about numbered citations in goal text", async () => {
		const h = setup({ choices: ["Ready"] });
		const file = await ready(h);
		writeFileSync(file, GOALS.replace("1. [/] goal: make the plot", "1. [/] goal: make the plot\n   as in\n   2024. [1] describes the baseline"));
		const count = h.shown.length;
		await h.hook("turn_end");
		expect(h.shown.length).toBe(count);
	});

	it("reports tasks that Markdown reads as text, once per distinct set", async () => {
		const h = setup({ choices: ["Ready"] });
		const file = await ready(h);
		writeFileSync(file, GOALS.replace("   - tasks:\n     1. [ ] load data", "   - tasks:\n     0. [/] check providers\n     1. [ ] load data"));
		await h.hook("turn_end");
		expect(h.shown.at(-1)?.content).toContain('"0. [/] check providers"');
		const count = h.shown.length;
		await h.hook("turn_end");
		expect(h.shown.length).toBe(count);
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

describe("pi-subagents completion notices in goal mode", () => {
	it("removes the report-or-continue text while working, and leaves other notices and other phases alone", async () => {
		const notice = (content: string, status = "completed") => ({ role: "custom", customType: "subagent-notify", content, display: false, timestamp: 1, details: { runs: [{ agent: "scout", status }] } });
		const done = notice(`Background task completed: **scout**\n\nfound 3 files\n\nParent action: ${SUBAGENT_COMPLETION_ACTION}`);
		const failed = notice(`Background task failed: **scout**\n\npermission denied\n\nParent action: ${SUBAGENT_COMPLETION_ACTION}`, "failed");
		const silent = { role: "custom", customType: "subagent-completion-unanswered", content: `Completion wake ended silently. See the subagent completion notices above. ${SUBAGENT_COMPLETION_ACTION}`, display: true, timestamp: 1 };
		const h = setup({ choices: ["Ready"] });
		await h.commands.get("goals").handler("new plot the data", h.ctx);
		expect(await h.hook("context", { messages: [done] })).toBeUndefined();

		const file = h.branch.findLast(e => e.customType === "pi-goals-single-agent").data.file;
		writeFileSync(file, GOALS);
		await h.tools.get("RequestPlanReview").execute();
		await h.hook("agent_settled");
		const child = (outcome: string) => ({ role: "custom", customType: "subagent-incremental-child-notify", content: `Child reader-1 ${outcome}.\n\nParent action: ${SUBAGENT_COMPLETION_ACTION}`, display: false, timestamp: 1, details: { childKey: "reader-1", outcome } });
		const out = await h.hook("context", { messages: [done, failed, silent, child("completed"), child("failed")] });
		expect(out.messages.map((m: any) => m.content)).toEqual([
			"Background task completed: **scout**\n\nfound 3 files",
			failed.content,
			"Completion wake ended silently. See the subagent completion notices above.",
			"Child reader-1 completed.",
			child("failed").content,
		]);
		expect(await h.hook("context", { messages: [failed] })).toBeUndefined();
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
	it.each(["tui", "rpc"])("shows one line for the [/] goal with its task in progress, excludes evidence, and fits the width (%s)", async (mode) => {
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
			expect(lines).toHaveLength(1);
			expect(stripVTControlCharacters(lines[0])).toMatch(/^◼ G1 1\/2 · Exp.*…$/);
			expect(lines.join("\n")).not.toMatch(/48\/89|old step|write the note/);
			for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
		}
		expect(readFileSync(file, "utf8")).toBe(text);
	});
});

describe("context after compaction and resume", () => {
	it("sends the goals file above the Log and the user's newest messages once after compaction", async () => {
		const h = setup({ choices: ["Ready"] });
		await ready(h);
		for (let n = 1; n <= 12; n++) await h.hook("input", { source: "interactive", text: `user message ${n}.` });
		await h.hook("before_agent_start");
		await h.hook("session_compact");
		const retry = await h.hook("context", { messages: [] });
		const text = retry.messages.at(-1).content[0].text as string;
		for (const kept of [LOOP, "A plot.", "1. [/] goal: make the plot", "[ ] load data", "user message 12.", "user message 3."]) expect(text).toContain(kept);
		for (const left of ["historical detail", "user message 2."]) expect(text).not.toContain(left);
		expect(text.indexOf("user message 12.")).toBeGreaterThan(text.indexOf("2. [ ] goal: write the note"));
		expect(await h.hook("context", { messages: [] })).toBeUndefined();
	});

	it("restores this session's goals on resume and ignores another session's state", async () => {
		const h = setup({ choices: ["Ready"] });
		await ready(h);
		await h.hook("session_start");
		expect((await h.hook("before_agent_start")).message.content).toContain(LOOP);
		expect(h.ctx.widget).toEqual(["◼ G1 1/2 · load data"]);
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
