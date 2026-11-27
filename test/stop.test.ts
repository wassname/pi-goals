// A stop with the goal open: the fresh judge decides whether the agent goes back to work.
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { liveDescendants, SUBAGENT_RUNNER } from "../src/index.js";
import { GOALS, type JudgeReply, setup, withNote } from "./harness.js";

const verdict = (value: unknown): JudgeReply => ({ status: "completed", value });
const state = (h: ReturnType<typeof setup>) => h.branch.findLast(e => e.customType === "pi-goals-single-agent").data;
async function working(judge?: JudgeReply, options: Parameters<typeof setup>[0] = {}) {
	const h = setup({ choices: ["Ready"], judge, ...options });
	await h.commands.get("goals").handler("new", h.ctx);
	writeFileSync(state(h).file, GOALS);
	await h.tools.get("RequestPlanReview").execute();
	await h.hook("agent_settled");
	await h.hook("before_agent_start");
	return h;
}
const tool = (h: ReturnType<typeof setup>) => h.hook("tool_call", { toolName: "bash", toolCallId: "c", input: { command: "ls" } });

describe("stop review", () => {
	it("sends the agent back with the fresh judge's one finding, which saw the page, the note, the last message and the user's words", async () => {
		const h = await working(verdict({ verdict: "continue", reason: "The search ran 8 steps and did not converge; the page asks for a found state.", next: "Rerun with 40 steps.", comment: "" }));
		writeFileSync(state(h).file, withNote(GOALS, "Search found nothing; waiting for the user to pick."));
		h.branch.push({ type: "message", message: { role: "assistant", content: [{ type: "text", text: "Drew view 100.\n\nOptions: (a) replicate, (b) larger scale, (c) write up.\nIt waits for your pick." }] } });
		await h.hook("input", { source: "interactive", text: "I'm afk, don't wait for me" });
		const out = await h.settle("No state found. The GPU is idle until you choose.", { entries: [{ type: "custom", customType: "other" }] });
		expect(out.continue).toBe(true);
		expect(out.entries[0]).toEqual({ type: "custom", customType: "other" });
		expect(out.entries[1]).toMatchObject({ type: "custom_message", customType: "goals-stop", display: true });
		for (const kept of ["did not converge", "Next: Rerun with 40 steps.", "not a message from the user", "can be wrong"]) expect(out.entries[1].content).toContain(kept);
		const request = h.requests[0];
		expect(request).toMatchObject({ agent: "pi-goals-judge", context: "fresh", model: "p/m" });
		expect(request.result.schema.properties.verdict.enum).toEqual(["continue", "wait", "blocked"]);
		for (const seen of ["Make the plot.", "waiting for the user to pick", "The GPU is idle until you choose.", "(after the agent's message that ended: \"… Drew view 100. / Options: (a) replicate, (b) larger scale, (c) write up. / It waits for your pick.\")\nI'm afk, don't wait for me"]) expect(request.task).toContain(seen);
		expect(h.agents[0].definition.tools).toEqual(["read", "grep", "find", "ls"]);
	});

	it.each(["wait", "blocked"])("accepts a stop the judge calls %s: a visible note and no continuation", async (kind) => {
		const h = await working(verdict({ verdict: kind, reason: "Job 1623 is running and its notice wakes the agent.", next: "", comment: "The demo runs on a spectrum direction before the planted-state check." }));
		const out = await h.settle("Queued job 1623; its notice wakes me.");
		expect(out.continue).toBeUndefined();
		expect(out.entries.at(-1).content).toContain(`accepted this stop (${kind}): Job 1623`);
		// A smaller risk the judge noticed goes to the user and the session file, not to the agent.
		const stop = out.entries.find((e: any) => e.customType === "goals-stop");
		expect(stop.content).not.toMatch(/spectrum direction/);
		const aside = out.entries.find((e: any) => e.customType === "goals-user-only");
		expect(aside).toMatchObject({ display: true, content: expect.stringMatching(/comment: The demo runs on a spectrum direction/) });
		// The context hook removes it before the agent sees the conversation.
		const context = await h.hook("context", { messages: [{ role: "user", content: "go" }, { role: "custom", customType: "goals-user-only", content: aside.content }] });
		expect(context.messages).toEqual([{ role: "user", content: "go" }]);
		expect(h.ctx.sessionManager.getEntries().filter((e: any) => e.customType === "pi-goals-judge-notes").map((e: any) => e.data.comment)).toEqual(["The demo runs on a spectrum direction before the planted-state check."]);
	});

	it("keeps going while the agent acts, stops asking once it answers without tools, and starts again after a wake from outside", async () => {
		const h = await working(verdict({ verdict: "continue", reason: "r", next: "n", comment: "" }));
		expect((await h.settle()).continue).toBe(true);
		await tool(h);
		expect((await h.settle()).continue).toBe(true);
		expect(await h.settle("No: job 12 is running and wakes me.")).toBeUndefined();
		expect(h.requests).toHaveLength(2);
		await h.hook("before_agent_start");
		expect((await h.settle()).continue).toBe(true);
	});

	it("caps continuations between wakes from outside", async () => {
		const h = await working(verdict({ verdict: "continue", reason: "r", next: "n", comment: "" }));
		let sent = 0;
		for (let n = 0; n < 15; n++) { await tool(h); if ((await h.settle())?.continue) sent++; }
		expect(sent).toBe(10);
	});

	it.each<[string, JudgeReply]>([["fails", { status: "failed", error: "quota" }], ["returns no verdict", verdict({ verdict: "maybe" })]])("asks the agent directly, and says so, when the judge %s", async (_name, judge) => {
		const h = await working(judge);
		const out = await h.settle();
		expect(out.continue).toBe(true);
		expect(out.entries[0].content).toMatch(/stop reviewer could not run \(.+\).*You stopped with the goal open/s);
	});

	it("with the judge off, asks the agent directly once per wake", async () => {
		const h = await working();
		await h.commands.get("goals").handler("judge off", h.ctx);
		const out = await h.settle();
		expect(out.entries[0].content).toContain("If a job, subagent or scheduled check that you started will wake you");
		expect(h.requests).toHaveLength(0);
		expect(await h.settle()).toBeUndefined();
	});

	it("gives way when the user speaks during the review", async () => {
		const h = await working("silent");
		const pending = h.settle();
		await new Promise((resolve) => setTimeout(resolve, 5));
		await h.hook("input", { source: "interactive", text: "wait, one question" });
		expect(await pending).toBeUndefined();
		expect(h.ctx.status).toMatch(/^goal working/);
	});

	it("leaves the agent idle while a subagent of this session is running, and reviews the stop once it has exited", async () => {
		const h = await working(verdict({ verdict: "continue", reason: "r", next: "n", comment: "" }));
		// A real child process whose command line carries the runner's path, as a background subagent's does.
		const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)", "--", `/x/node_modules/${SUBAGENT_RUNNER}-preload.mjs`], { stdio: "ignore" });
		try {
			await expect.poll(() => liveDescendants()).toBe(1);
			expect(await h.settle("Helper is drawing the map.")).toBeUndefined();
			expect(h.requests).toHaveLength(0);
		} finally {
			child.kill();
			await new Promise((resolve) => child.once("exit", resolve));
		}
		expect(await liveDescendants()).toBe(0);
		expect((await h.settle()).continue).toBe(true);
	});

	it("does not review a stop while planning or paused, after an error or abort, or when more work is already queued", async () => {
		const h = await working(verdict({ verdict: "continue", reason: "r", next: "n", comment: "" }));
		expect(await h.settle("x", { outcome: "aborted" })).toBeUndefined();
		expect(await h.settle("x", { outcome: "error" })).toBeUndefined();
		expect(await h.settle("x", { continue: true })).toBeUndefined();
		expect(await h.settle("x", { context: { llmMessages: [], pendingMessages: [{ role: "user" }] } })).toBeUndefined();
		await h.commands.get("goals").handler("pause", h.ctx);
		expect(await h.settle()).toBeUndefined();
		const planning = setup({ judge: verdict({ verdict: "continue", reason: "r", next: "n", comment: "" }) });
		await planning.commands.get("goals").handler("new", planning.ctx);
		expect(await planning.settle()).toBeUndefined();
		expect(h.requests).toHaveLength(0);
	});
});
