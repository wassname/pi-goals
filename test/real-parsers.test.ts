// Checks the fakes in harness.ts against the real scheduler core and pi-subagents parsers.
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { registerRuntimeAgentEventListener } from "../node_modules/pi-subagents/src/agents/runtime-agent-events.js";
import { parseSubagentDelegationRequest } from "../node_modules/pi-subagents/src/slash/delegation-request.js";
import { runJudge } from "../src/judge.js";
import { marker, wakeToken } from "../src/loop.js";

const core = createRequire(import.meta.url)("@jl1990/pi-scheduler/extensions/scheduler/scheduler-core.cjs");

describe("real pi-scheduler core", () => {
	it("our /schedule payload creates a recurring session prompt whose receipt carries the marker", () => {
		const parsed = core.splitScheduleCommand(`prompt every 1h :: ${marker("abc-1")}`, new Date());
		const task = core.createScheduledTask({ action: parsed.action, type: parsed.type, schedule: parsed.schedule, prompt: parsed.payload, scope: "session", sessionFile: "/s.jsonl", cwd: "/" }, new Date());
		expect(task).toMatchObject({ action: "prompt", type: "interval", prompt: "pi-goals-loop:abc-1", scope: "session", sessionFile: "/s.jsonl" });
	});

	it("wakeToken reads the scheduler's real header format", () => {
		const header = "[Scheduled task t1 fired]\nName: (unnamed)\nAction: prompt\nType: interval\nSchedule: 1h\nScheduled for: 2026\n\n";
		expect(wakeToken(`${header}${marker("abc-1")}`)).toBe("abc-1");
		expect(wakeToken(`${header}do something else\n${marker("abc-1")} please`)).toBeUndefined();
	});
});

describe("real pi-subagents parsers", () => {
	it("registers the judge agent and emits a request the real parser accepts", async () => {
		const listeners = new Map<string, Array<(data: unknown) => void>>();
		const events = {
			emit: (channel: string, data: unknown) => { for (const handler of listeners.get(channel) ?? []) handler(data); },
			on: (channel: string, handler: (data: unknown) => void) => { listeners.set(channel, [...(listeners.get(channel) ?? []), handler]); return () => {}; },
		};
		registerRuntimeAgentEventListener({ events, on: () => {}, registerTool: () => {} } as any);
		const parsed: unknown[] = [];
		events.on("prompt-template:subagent:request", (data) => parsed.push(parseSubagentDelegationRequest(data)));
		const out = await runJudge(events, { goal: "g", text: "t", path: "p", cwd: "/tmp", model: "p/m" }, undefined, { startMs: 5, totalMs: 50 });
		expect(out).toMatchObject({ ok: false, error: expect.stringMatching(/did not start/) });
		expect(parsed[0]).toMatchObject({ ok: true, request: { agent: "pi-goals-judge", context: "fresh" } });
	});
});
