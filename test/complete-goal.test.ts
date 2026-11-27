import { readFileSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { section } from "../src/goals.js";
import { runJudge } from "../src/judge.js";
import { judgeSchema } from "../src/prompts.js";
import { GOALS, type JudgeReply, setup } from "./harness.js";

async function working(judge?: JudgeReply, subagents = true, onRequest?: () => void) {
	const h = setup({ choices: ["Ready"], judge, subagents, onRequest });
	await h.commands.get("goals").handler("new", h.ctx);
	const file = h.branch.findLast(e => e.customType === "pi-goals-single-agent").data.file as string;
	writeFileSync(file, GOALS);
	await h.tools.get("RequestPlanReview").execute();
	await h.hook("agent_settled");
	h.schedulerReceipt("t1");
	return { ...h, file };
}
const state = (h: Awaited<ReturnType<typeof working>>) => h.branch.findLast(e => e.customType === "pi-goals-single-agent").data;

describe("CompleteGoal", () => {
	it("accept finishes the goal: one evidence line, no more reminders, and a request for the report in the agreed layout", async () => {
		const h = await working();
		const result = await h.complete();
		expect(state(h)).toMatchObject({ phase: "paused", done: "accepted" });
		expect(section(readFileSync(h.file, "utf8"), "Evidence")).toMatch(/^- \d{4}-\d\d-\d\d \d\d:\d\d accepted by the sign-off judge; \.pi\/goals\/reviews\/.*\.json$/);
		expect(h.sent.at(-1)?.text).toBe("/schedule-remove t1");
		const text = result.content[0].text;
		expect(text).not.toContain("[pi-goals: resync]");
		expect(text).toContain("| run | score-placeholder |");
		expect(h.ctx.widget.slice(0, 2)).toEqual(["● goal accepted · click to expand", "  A plot. Make the plot."]);
		expect(await h.settle()).toBeUndefined();
		expect(h.requests).toHaveLength(1);
		expect(h.requests[0]).toMatchObject({ agent: "pi-goals-judge", context: "fresh", model: "p/m", result: { kind: "structured" } });
		expect(h.requests[0].task).toContain("A plot.");
		expect(h.agents[0].definition.tools).toEqual(["read", "grep", "find", "ls"]);
		expect(h.agents[0].disposed).toBe(true);
	});

	it("passes the current project AGENTS.md as a separate source, without giving it judge authority", async () => {
		const h = await working();
		const path = `${h.cwd}/AGENTS.md`;
		const projectText = "# Project intent\nTrain one general map; do not optimise separately on each test prompt.\n";
		writeFileSync(path, projectText);
		await h.complete();
		const task = h.requests[0].task as string;
		expect(task).toContain(GOALS);
		expect(task).toContain(projectText);
		expect(task.indexOf(path)).toBeGreaterThan(task.indexOf(GOALS) + GOALS.length);
		expect(task.indexOf(projectText)).toBeGreaterThan(task.indexOf(path));
		expect(h.agents[0].definition.systemPrompt).not.toContain(projectText);
		expect(h.agents[0].definition.inheritProjectContext).toBe(false);
	});

	it.each<[string, JudgeReply]>([
		["reject", { status: "completed", value: { verdict: "reject", checks: [], missing: "no plot file" } }],
		["accept without checked files", { status: "completed", value: { verdict: "accept", checks: [], missing: "" } }],
		["judge failure", { status: "failed", error: "quota" }],
		["malformed verdict", { status: "completed", value: { verdict: "maybe" } }],
	])("%s leaves the goal unfinished", async (_name, judge) => {
		const h = await working(judge);
		const result = await h.complete();
		expect(state(h)).toMatchObject({ phase: "working", done: undefined });
		expect(readFileSync(h.file, "utf8")).toBe(GOALS);
		expect(result.content[0].text).not.toContain("is finished");
	});

	it("missing pi-subagents leaves the goal unfinished", async () => {
		const h = await working(undefined, false);
		expect((await h.complete()).content[0].text).toMatch(/unavailable/);
		expect(state(h).phase).toBe("working");
	});

	it("with the judge disabled records self-verification, not acceptance", async () => {
		const h = await working();
		await h.commands.get("goals").handler("judge off", h.ctx);
		await h.complete();
		expect(state(h).done).toBe("self-verified");
		expect(section(readFileSync(h.file, "utf8"), "Evidence")).toContain("self-verified (sign-off judge disabled)");
		expect(h.requests).toHaveLength(0);
	});

	it("refuses completion before Ready, and /goals resume reopens a finished goal", async () => {
		const fresh = setup();
		await fresh.commands.get("goals").handler("new", fresh.ctx);
		await expect(fresh.complete()).rejects.toThrow(/Ready/);
		const h = await working();
		await h.complete();
		await expect(h.complete()).rejects.toThrow(/Ready or resume/);
		await h.commands.get("goals").handler("resume", h.ctx);
		expect(state(h)).toMatchObject({ phase: "working", done: undefined });
	});

	it("does not record completion when the goals file changed during review", async () => {
		const edit = { file: "" };
		const h = await working(undefined, true, () => writeFileSync(edit.file, GOALS.replace("A plot.", "A different plot.")));
		edit.file = h.file;
		await expect(h.complete()).rejects.toThrow(/changed during review/);
		expect(state(h).phase).toBe("working");
	});
});

describe("runJudge", () => {
	it("times out when pi-subagents never starts the request", async () => {
		const h = setup({ judge: "silent" });
		const out = await runJudge(h.events, { task: "t", schema: judgeSchema, cwd: "." }, undefined, { startMs: 5, totalMs: 50 });
		expect(out).toMatchObject({ ok: false, error: expect.stringMatching(/did not start/) });
		expect(h.agents[0].disposed).toBe(true);
	});
});
