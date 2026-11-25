// PI/OpenAI: Ready authorizes work; scheduler receipts only confirm reminders.
import { readFileSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { appendLog } from "../src/goals.js";
import { GOALS, setup } from "./harness.js";

const state = (h: ReturnType<typeof setup>) => h.branch.findLast(e => e.customType === "pi-goals-single-agent").data;
const command = (h: ReturnType<typeof setup>, arg: string) => h.commands.get("goals").handler(arg, h.ctx);
const starts = (h: ReturnType<typeof setup>) => h.sent.filter(m => m.text.startsWith("[pi-goals] The user approved"));
const creates = (h: ReturnType<typeof setup>) => h.sent.filter(m => m.text.startsWith("/schedule "));
const notices = (h: ReturnType<typeof setup>) => h.shown.filter(m => m.customType === "goals-startup" && m.display).map(m => m.content);
const log = (h: ReturnType<typeof setup>) => readFileSync(state(h).file, "utf8").split("## Log")[1];
async function ready(options: Parameters<typeof setup>[0] = {}) {
	const h = setup({ choices: ["Ready"], autoSchedule: false, ...options });
	await command(h, "new");
	writeFileSync(state(h).file, GOALS);
	await h.tools.get("RequestPlanReview").execute();
	await h.hook("agent_settled");
	return h;
}

describe("Ready and scheduler startup", () => {
	it.each([{ schedulerLoaded: false }, { schedulerVersion: "0.5.1" }])("starts work and logs an unavailable scheduler: %j", async options => {
		const h = await ready(options);
		expect(state(h).phase).toBe("working");
		expect(creates(h)).toHaveLength(0);
		expect(starts(h)).toHaveLength(1);
		expect(await h.hook("tool_call", { toolName: "write", input: { path: "work.ts" } })).toBeUndefined();
		expect(notices(h)).toEqual([expect.stringContaining("pi install npm:@jl1990/pi-scheduler@0.6.0")]);
		expect(log(h)).toContain(notices(h)[0]);
		await h.hook("session_start");
		await h.hook("agent_settled");
		expect(state(h).phase).toBe("working");
		expect(notices(h)).toHaveLength(1);
	});

	it("does not approve an edited plan while the menu is open", async () => {
		const h = setup();
		await command(h, "new");
		const file = state(h).file;
		writeFileSync(file, GOALS);
		h.ctx.ui.select = async () => { writeFileSync(file, GOALS.replace("A plot.", "A different plot.")); return "Ready"; };
		await command(h, "review");
		expect(state(h).phase).toBe("planning");
		expect(creates(h)).toHaveLength(0);
		expect(notices(h)).toEqual([expect.stringContaining("Work did not start")]);
		expect(log(h)).toContain(notices(h)[0]);
	});

	it("ignores Log and Interview entries while the menu is open and after Ready", async () => {
		const h = setup({ autoStart: false });
		await command(h, "new");
		const file = state(h).file;
		writeFileSync(file, GOALS);
		h.ctx.ui.select = async () => {
			await h.hook("input", { source: "interactive", text: "first user note" });
			writeFileSync(file, appendLog(readFileSync(file, "utf8"), "first log note"));
			return "Ready";
		};
		await command(h, "review");
		expect(state(h).phase).toBe("working");
		await h.hook("input", { source: "interactive", text: "second user note" });
		writeFileSync(file, appendLog(readFileSync(file, "utf8"), "second log note"));
		const marker = h.sent.at(-1)!.text;
		const input = () => h.hook("input", { source: "extension", text: marker });
		expect(await input()).toMatchObject({ action: "transform", text: expect.stringContaining("second user note") });
		expect(await input()).toEqual({ action: "handled" });
		expect(log(h)).toContain("second log note");
		expect(notices(h)).toHaveLength(0);
	});

	it("records a missing receipt once, then recognizes a late receipt without another create", async () => {
		const h = await ready();
		expect(state(h).phase).toBe("working");
		expect(starts(h)).toHaveLength(1);
		await h.hook("agent_settled");
		await h.hook("agent_settled");
		expect(notices(h)).toEqual([expect.stringContaining("not confirmed")]);
		expect(log(h)).toContain(notices(h)[0]);
		h.schedulerReceipt("owned");
		await command(h, "retry");
		expect(creates(h)).toHaveLength(1);
		expect(notices(h).at(-1)).toContain("confirmed the hourly reminder");
	});

	it.each([
		{ sessionFile: "/foreign.jsonl" }, { scope: "global" }, { action: "shell" }, { id: "bad id" },
		{ enabled: false }, { status: "failed" }, { type: "once" }, { schedule: "2h" }, { prompt: "pi-goals-loop:foreign" },
	])("does not treat a foreign or malformed receipt as confirmation: %j", async change => {
		const h = await ready();
		h.schedulerReceipt("owned");
		Object.assign(h.branch.at(-1).details.task, change);
		await h.hook("agent_settled");
		expect(state(h).phase).toBe("working");
		expect(notices(h)[0]).toContain("not confirmed");
		await command(h, "pause");
		expect(h.sent.some(m => m.text.startsWith("/schedule-remove"))).toBe(false);
	});

	it.each(["pause", "clear"])("%s drops a queued kickoff and removes a late owned reminder", async action => {
		const h = await ready({ autoStart: false });
		const marker = h.sent.at(-1)!.text;
		await command(h, action);
		h.schedulerReceipt("late");
		expect(await h.hook("input", { source: "extension", text: marker })).toEqual({ action: "handled" });
		await h.hook("agent_settled");
		expect(h.sent.at(-1)?.text).toBe("/schedule-remove late");
		expect(state(h).phase).toBe(action === "pause" ? "paused" : null);
	});

	it("can retry only the reminder, not the kickoff", async () => {
		const h = await ready();
		await h.hook("agent_settled");
		const previousToken = state(h).token;
		await command(h, "retry");
		expect(state(h).token).not.toBe(previousToken);
		expect(creates(h)).toHaveLength(2);
		expect(starts(h)).toHaveLength(1);
		const prompt = h.schedulerReceipt("retried");
		await h.hook("agent_settled");
		expect(await h.wake("retried", prompt)).toMatchObject({ action: "transform" });
	});

	it("review reopens Ready for a session left in the old starting phase", async () => {
		const h = await ready();
		const file = state(h).file;
		const { token, reminderSource: source } = state(h);
		h.branch.push({ type: "custom", customType: "pi-goals-single-agent", data: { owner: "sess", phase: "starting", file, startup: { token, source }, judge: true } });
		h.schedulerReceipt("old");
		await h.hook("session_start");
		h.ctx.ui.select = async () => "Ready";
		await command(h, "review");
		expect(h.sent.some(m => m.text === "/schedule-remove old")).toBe(true);
		expect(log(h)).toContain("previous startup did not finish");
		expect(state(h)).toMatchObject({ phase: "working", file });
		expect(state(h).token).not.toBe(token);
	});
});
