import { readFileSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { runJudge } from "../src/judge.js";
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
const goalLine = (file: string) => readFileSync(file, "utf8").split("\n").find(l => l.includes("goal: make the plot"));

describe("CompleteGoal", () => {
	it("accept marks [✓] and logs; the judge is fresh, read-only and gets the goals file", async () => {
		const h = await working();
		await h.complete("make the plot");
		expect(goalLine(h.file)).toContain("[✓]");
		expect(readFileSync(h.file, "utf8")).toMatch(/accepted "make the plot"/);
		expect(h.requests[0]).toMatchObject({ agent: "pi-goals-judge", context: "fresh", model: "p/m", result: { kind: "structured" } });
		expect(h.requests[0].task).toContain("## User-visible result");
		expect(h.agents[0].definition.tools).toEqual(["read", "grep", "find", "ls"]);
		expect(h.agents[0].disposed).toBe(true);
	});

	it.each<[string, JudgeReply]>([
		["reject", { status: "completed", value: { verdict: "reject", checks: [], missing: "no plot file" } }],
		["accept without checked files", { status: "completed", value: { verdict: "accept", checks: [], missing: "" } }],
		["judge failure", { status: "failed", error: "quota" }],
		["malformed verdict", { status: "completed", value: { verdict: "maybe" } }],
	])("%s leaves the goal unfinished", async (_name, judge) => {
		const h = await working(judge);
		await h.complete("make the plot");
		expect(goalLine(h.file)).toContain("[/]");
	});

	it("missing pi-subagents leaves the goal unfinished", async () => {
		const h = await working(undefined, false);
		expect((await h.complete("make the plot")).content[0].text).toMatch(/Judge unavailable/);
		expect(goalLine(h.file)).toContain("[/]");
	});

	it("with the judge disabled records [x] self-verification, not acceptance", async () => {
		const h = await working();
		await h.commands.get("goals").handler("judge off", h.ctx);
		await h.complete("make the plot");
		expect(goalLine(h.file)).toContain("[x]");
		expect(h.requests).toHaveLength(0);
	});

	it("rejects an unknown goal and completion before Ready", async () => {
		const h = await working();
		await expect(h.complete("make a plot")).rejects.toThrow(/exact/);
		const fresh = setup();
		await fresh.commands.get("goals").handler("new", fresh.ctx);
		await expect(fresh.complete("make the plot")).rejects.toThrow(/Ready/);
	});

	it("does not record completion when the goals file changed during review", async () => {
		const edit = { file: "" };
		const h = await working(undefined, true, () => writeFileSync(edit.file, GOALS.replace("A plot.", "A different plot.")));
		edit.file = h.file;
		await expect(h.complete("make the plot")).rejects.toThrow(/changed during review/);
		expect(goalLine(h.file)).toContain("[/]");
	});

	it("accepting the last goal removes the scheduled loop", async () => {
		const h = await working();
		writeFileSync(h.file, GOALS.replace("[ ] goal: write", "[-] goal: write"));
		await h.complete("make the plot");
		expect(h.sent.at(-1)?.text).toBe("/schedule-remove t1");
	});
});

describe("runJudge", () => {
	it("times out when pi-subagents never starts the request", async () => {
		const h = setup({ judge: "silent" });
		const out = await runJudge(h.events, { goal: "g", text: "t", path: "p", cwd: "." }, undefined, { startMs: 5, totalMs: 50 });
		expect(out).toMatchObject({ ok: false, error: expect.stringMatching(/did not start/) });
		expect(h.agents[0].disposed).toBe(true);
	});
});
