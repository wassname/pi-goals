// PI/OpenAI: Ready authorization comes from durable owned receipts, not command dispatch.
import { readFileSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { GOALS, setup } from "./harness.js";

const state = (h: ReturnType<typeof setup>) => h.branch.findLast(e => e.customType === "pi-goals-single-agent").data;
async function pending(options: Parameters<typeof setup>[0] = {}) {
	const h = setup({ choices: ["Ready"], autoSchedule: false, ...options });
	await h.commands.get("goals").handler("new", h.ctx);
	writeFileSync(state(h).file, GOALS);
	await h.tools.get("RequestPlanReview").execute();
	await h.hook("agent_settled");
	return h;
}
const command = (h: ReturnType<typeof setup>, arg: string) => h.commands.get("goals").handler(arg, h.ctx);
const starts = (h: ReturnType<typeof setup>) => h.sent.filter(m => m.text.startsWith("[pi-goals] The user approved"));
const creates = (h: ReturnType<typeof setup>) => h.sent.filter(m => m.text.startsWith("/schedule "));

describe("scheduler startup confirmation", () => {
	it.each([{ schedulerLoaded: false }, { schedulerVersion: "0.5.1" }])("keeps planning usable when scheduler is unavailable: %j", async options => {
		const h = await pending(options);
		expect(state(h).phase).toBe("planning");
		expect(readFileSync(state(h).file, "utf8")).toBe(GOALS);
		expect(h.notes.join("\n")).toContain("pi install npm:@jl1990/pi-scheduler@0.6.0");
		expect(creates(h)).toHaveLength(0);
		expect(starts(h)).toHaveLength(0);
	});

	it("a saved receipt cannot start work after its scheduler is unloaded", async () => {
		const h = await pending();
		h.schedulerReceipt("owned");
		h.pi.getCommands = () => [];
		await command(h, "resume");
		expect(state(h).phase).toBe("starting");
		expect(starts(h)).toHaveLength(0);
		expect(h.notes.at(-1)).toContain("Load exactly one");
	});

	it("Ready cannot approve a file changed while its menu was open", async () => {
		const h = setup();
		await command(h, "new");
		const file = state(h).file;
		writeFileSync(file, GOALS);
		h.ctx.ui.select = async () => { writeFileSync(file, GOALS.replace("A plot.", "A different plot.")); return "Ready"; };
		await command(h, "review");
		expect(state(h).phase).toBe("planning");
		expect(creates(h)).toHaveLength(0);
		expect(h.notes.at(-1)).toContain("Ready menu was open");
	});

	it("delayed confirmation keeps tools blocked, and resume confirms exactly once without a second create", async () => {
		const h = await pending();
		expect(state(h).phase).toBe("starting");
		expect(starts(h)).toHaveLength(0);
		expect(await h.hook("tool_call", { toolName: "write", input: { path: "work.ts" } })).toMatchObject({ block: true });
		await command(h, "resume");
		await command(h, "review");
		expect(creates(h)).toHaveLength(1);
		h.schedulerReceipt("owned");
		await command(h, "resume");
		await command(h, "resume");
		expect(state(h).phase).toBe("working");
		expect(starts(h)).toHaveLength(1);
		expect(creates(h)).toHaveLength(1);
	});

	it.each([
		{ sessionFile: "/foreign.jsonl" }, { scope: "global" }, { action: "shell" }, { id: "bad id" },
		{ enabled: false }, { status: "failed" }, { type: "once" }, { schedule: "2h" }, { prompt: "pi-goals-loop:foreign" },
	])("cannot authorize work with a mismatched or malformed receipt: %j", async change => {
		const h = await pending();
		h.schedulerReceipt("owned");
		Object.assign(h.branch.at(-1).details.task, change);
		await command(h, "resume");
		expect(state(h).phase).toBe("starting");
		expect(starts(h)).toHaveLength(0);
	});

	it.each(["pause", "clear"])("%s invalidates startup and removes a late owned receipt", async action => {
		const h = await pending();
		const token = state(h).startup.token;
		await command(h, action);
		h.schedulerReceipt("late");
		await command(h, `confirm ${token}`);
		expect(starts(h)).toHaveLength(0);
		expect(h.sent.at(-1)?.text).toBe("/schedule-remove late");
		expect(state(h).phase).toBe(action === "pause" ? "paused" : null);
	});

	it("changed approved content returns to planning and cleans up the receipt", async () => {
		const h = await pending();
		writeFileSync(state(h).file, GOALS.replace("A plot.", "A different result."));
		h.schedulerReceipt("stale");
		await command(h, "resume");
		expect(state(h).phase).toBe("planning");
		expect(starts(h)).toHaveLength(0);
		expect(h.sent.at(-1)?.text).toBe("/schedule-remove stale");
	});

	it.each(["pause", "change"])("rechecks %s between confirmation and queued work delivery", async action => {
		const h = await pending({ autoStart: false });
		h.schedulerReceipt("owned");
		await command(h, "resume");
		const marker = h.sent.at(-1)!.text;
		expect(state(h).phase).toBe("starting");
		if (action === "pause") await command(h, "pause");
		else writeFileSync(state(h).file, GOALS.replace("A plot.", "A different plot."));
		expect(await h.hook("input", { source: "extension", text: marker })).toEqual({ action: "handled" });
		expect(state(h).phase).toBe(action === "pause" ? "paused" : "planning");
		expect(starts(h)).toHaveLength(0);
	});

	it("retry confirms an existing receipt without replacing its reminder", async () => {
		const h = await pending();
		h.schedulerReceipt("owned");
		await command(h, "retry");
		expect(state(h).phase).toBe("working");
		expect(creates(h)).toHaveLength(1);
		expect(starts(h)).toHaveLength(1);
	});

	it("retry cannot approve changed content", async () => {
		const h = await pending();
		writeFileSync(state(h).file, GOALS.replace("A plot.", "A different result."));
		await command(h, "retry");
		expect(state(h).phase).toBe("planning");
		expect(creates(h)).toHaveLength(1);
	});

	it("reload repairs an older false-working record without losing the goals file", async () => {
		const h = await pending();
		const file = state(h).file;
		h.branch.push({ type: "custom", customType: "pi-goals-single-agent", data: { owner: "sess", phase: "working", file, token: "old", judge: true } });
		await h.hook("session_start");
		expect(state(h).phase).toBe("paused");
		expect(readFileSync(file, "utf8")).toBe(GOALS);
		expect(h.notes.at(-1)).toContain("without a valid scheduler receipt");
	});

	it("reload keeps pending identity; resume reuses its receipt", async () => {
		const h = await pending();
		const token = state(h).startup.token;
		await h.hook("session_shutdown");
		await h.hook("session_start");
		expect(state(h).startup.token).toBe(token);
		h.schedulerReceipt("owned");
		await command(h, "resume");
		expect(state(h).phase).toBe("working");
		expect(creates(h)).toHaveLength(1);
		expect(starts(h)).toHaveLength(1);
	});

	it("session replacement cannot use the old receipt or start marker", async () => {
		const h = await pending();
		const token = state(h).startup.token;
		await h.hook("session_shutdown");
		h.ctx.sessionManager.getSessionId = () => "replacement";
		h.ctx.sessionManager.getSessionFile = () => "/replacement.jsonl";
		await h.hook("session_start");
		await command(h, `confirm ${token}`);
		expect(starts(h)).toHaveLength(0);
		expect(h.sent.some(m => m.text.startsWith("/schedule-remove"))).toBe(false);
		expect(await h.hook("input", { source: "extension", text: `[pi-goals:start-work:${token}]` })).toEqual({ action: "handled" });
	});

	it("explicit retry abandons the old approval token and a late receipt cannot start it", async () => {
		const h = await pending();
		const oldToken = state(h).startup.token;
		await command(h, "retry");
		expect(creates(h)).toHaveLength(2);
		const oldCommand = creates(h)[0];
		h.branch.push({ type: "custom_message", customType: "scheduled-task", details: { task: { id: "old", prompt: oldCommand.text.split(" :: ")[1], action: "prompt", type: "interval", schedule: "1h", enabled: true, status: "pending", scope: "session", sessionFile: h.ctx.sessionManager.getSessionFile() } } });
		await command(h, `confirm ${oldToken}`);
		expect(starts(h)).toHaveLength(0);
		expect(h.sent.at(-1)?.text).toBe("/schedule-remove old");
	});
});
