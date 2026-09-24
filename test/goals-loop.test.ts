import { readFileSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
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
		expect(file).toMatch(/\.pi\/goals\/sess-[\w]+\.md$/);
		writeFileSync(file, GOALS);
		await h.hook("input", { source: "interactive", text: "yes, reuse judge_demos.py" });
		expect(readFileSync(file, "utf8")).toContain("> yes, reuse judge_demos.py");
		expect(await h.hook("tool_call", { toolName: "bash", input: { command: "python train.py" } })).toMatchObject({ block: true });
		expect(await h.hook("tool_call", { toolName: "write", input: { path: file } })).toBeUndefined();
		expect(h.sent.some(m => m.text.startsWith("/schedule "))).toBe(false);

		await h.tools.get("RequestPlanReview").execute();
		await h.hook("agent_settled");
		expect(h.sent.filter(m => m.text.startsWith("/schedule ")).length).toBe(1);
		expect(await h.hook("tool_call", { toolName: "bash", input: { command: "python train.py" } })).toBeUndefined();
	});

	it("Cancel starts nothing and keeps the file", async () => {
		const h = setup({ choices: ["Cancel"] });
		const file = await ready(h);
		expect(h.sent.some(m => m.text.startsWith("/schedule "))).toBe(false);
		expect(readFileSync(file, "utf8")).toContain("goal: make the plot");
	});
});

describe("scheduled loop wake", () => {
	it("injects the current loop statement and goals from disk, without Log history", async () => {
		const h = setup({ choices: ["Ready"] });
		const file = await ready(h);
		const prompt = h.schedulerReceipt("t1");
		writeFileSync(file, GOALS.replace("A plot.", "A plot with error bars."));
		const out = await h.wake("t1", prompt);
		expect(out.action).toBe("transform");
		expect(out.text).toContain(LOOP);
		expect(out.text).toContain("A plot with error bars.");
		expect(out.text).toContain("goal: make the plot");
		expect(out.text).not.toContain("historical detail");
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
		expect(h.ctx.widget[0]).toBe("◼ G1: make the plot");
		expect(h.ctx.widget[1]).toBe("   ◦ load data");
		h.branch.push({ type: "custom", customType: "pi-goals-single-agent", data: { owner: "other", phase: "working", file: "x", judge: true } });
		await h.hook("session_start");
		expect(await h.hook("before_agent_start")).toBeUndefined();
		expect(h.ctx.widget).toBeUndefined();
	});
});
