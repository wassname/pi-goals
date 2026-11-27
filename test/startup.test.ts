// PI/OpenAI: Ready authorizes work; scheduler receipts only confirm reminders.
import { writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { GOALS, setup } from "./harness.js";

const state = (h: ReturnType<typeof setup>) => h.branch.findLast(e => e.customType === "pi-goals-single-agent").data;
const command = (h: ReturnType<typeof setup>, arg: string) => h.commands.get("goals").handler(arg, h.ctx);
const starts = (h: ReturnType<typeof setup>) => h.sent.filter(m => m.text.startsWith("[pi-goals] The user approved"));
const creates = (h: ReturnType<typeof setup>) => h.sent.filter(m => m.text.startsWith("/schedule "));
const notices = (h: ReturnType<typeof setup>) => h.shown.filter(m => m.customType === "goals-startup" && m.display).map(m => m.content);
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
		expect(h.ctx.status).toContain("scheduler: unconfirmed");
		expect(notices(h)).toEqual([expect.stringContaining("pi install npm:@jl1990/pi-scheduler@0.6.0")]);
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
	});

	it("records a missing receipt once, then recognizes a late receipt without another create", async () => {
		const h = await ready();
		expect(state(h).phase).toBe("working");
		expect(starts(h)).toHaveLength(1);
		await h.hook("agent_settled");
		await h.hook("agent_settled");
		expect(notices(h)).toEqual([expect.stringContaining("not confirmed")]);
		h.schedulerReceipt("owned");
		await command(h, "retry");
		expect(creates(h)).toHaveLength(1);
		expect(notices(h).at(-1)).toContain("confirmed the reminder");
		expect(h.ctx.status).not.toContain("scheduler: unconfirmed");
	});

	it.each([{ sessionFile: "/foreign.jsonl" }, { enabled: false }, { id: "bad id" }])("does not treat a foreign or malformed receipt as confirmation: %j", async change => {
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

	it("warns about a malformed reminder without pausing work or blocking the next reminder", async () => {
		const h = await ready({ autoSchedule: true });
		const task = h.branch.findLast(e => e.customType === "scheduled-task").details.task;
		const malformed = `[Scheduled task ${task.id} fired]\n\n${task.prompt}`;
		expect(await h.hook("input", { source: "extension", text: malformed })).toEqual({ action: "handled" });
		expect(state(h).phase).toBe("working");
		expect(notices(h)).toEqual([expect.stringMatching(/Scheduler warning:.*no Schedule line/)]);
		expect(await h.wake(task.id, task.prompt)).toMatchObject({ action: "transform" });
	});
});
