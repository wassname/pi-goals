// Checks the judge request against the installed pi-subagents parser.
import { describe, expect, it } from "vitest";
import { registerRuntimeAgentEventListener } from "../node_modules/pi-subagents/src/agents/runtime-agent-events.js";
import { COMPLETION_ACTION } from "../node_modules/pi-subagents/src/shared/parent-wake.js";
import { parseSubagentDelegationRequest } from "../node_modules/pi-subagents/src/slash/delegation-request.js";
import { marker, SUBAGENT_COMPLETION_ACTION, wakeSchedule, wakeToken } from "../src/index.js";
import { runJudge } from "../src/judge.js";
import { stopSchema } from "../src/prompts.js";

describe("scheduler wakes", () => {
	it("reads a scheduler header and rejects an inline marker", () => {
		const header = "[Scheduled task t1 fired]\nName: (unnamed)\nAction: prompt\nType: interval\nSchedule: 1h\nScheduled for: 2026\n\n";
		expect(wakeToken(`${header}${marker("abc-1")}`)).toBe("abc-1");
		expect(wakeToken(`${header}do something else\n${marker("abc-1")} please`)).toBeUndefined();
		expect(wakeSchedule(`${header}${marker("abc-1")}`)).toEqual({ id: "t1", schedule: "1h" });
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
		const out = await runJudge(events, { task: "t", schema: stopSchema, cwd: "/tmp", model: "p/m" }, undefined, { startMs: 5, totalMs: 50 });
		expect(out).toMatchObject({ ok: false, error: expect.stringMatching(/did not start/) });
		expect(parsed[0]).toMatchObject({ ok: true, request: { agent: "pi-goals-judge", context: "fresh" } });
	});
});

describe("pi-subagents completion text that goals mode removes", () => {
	it("matches the installed completion text that production removes verbatim", () => {
		expect(SUBAGENT_COMPLETION_ACTION).toBe(COMPLETION_ACTION);
	});
});
