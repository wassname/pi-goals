import { describe, expect, it } from "vitest";
import {
	GOAL_WORKER_AGENT,
	processWorkState,
	registerGoalSupervisor,
	resumeGoalSupervisor,
	startGoalSupervisor,
	steerGoalSupervisor,
	stopGoalSupervisor,
	subagentWorkState,
	supervisorSystemPrompt,
	terminalSteerError,
} from "../src/worker.js";

class Events {
	private handlers = new Map<string, Set<(data: unknown) => void>>();

	on(event: string, handler: (data: unknown) => void): () => void {
		const handlers = this.handlers.get(event) ?? new Set();
		handlers.add(handler);
		this.handlers.set(event, handlers);
		return () => handlers.delete(handler);
	}

	emit(event: string, data: unknown): void {
		for (const handler of [...(this.handlers.get(event) ?? [])]) handler(data);
	}
}

function replyToRpc(events: Events, inspect: (request: any) => object): void {
	events.on("subagents:rpc:v1:request", (raw) => {
		const request = raw as any;
		events.emit(`subagents:rpc:v1:reply:${request.requestId}`, { success: true, data: inspect(request) });
	});
}

describe("goal hierarchy registration", () => {
	it("registers the supervisor contract and names its packaged foreground worker", () => {
		const events = new Events();
		const definitions = new Map<string, Record<string, unknown>>();
		events.on("pi-subagents:runtime-agent-register:v1", (raw) => {
			const request = raw as { name: string; definition: Record<string, unknown>; result?: unknown };
			definitions.set(request.name, request.definition);
			request.result = { ok: true, registration: { dispose() {} } };
		});

		registerGoalSupervisor(events, "provider/supervisor");

		const supervisor = definitions.get("goal-supervisor");
		expect(supervisor).toMatchObject({
			model: "provider/supervisor",
			defaultContext: "fork",
			defaultAsync: true,
			thinking: "low",
			inheritProjectContext: false,
			inheritGlobalContext: false,
			inheritSkills: false,
			defaultProgress: true,
			allowNestedSubagents: true,
			tools: ["read", "grep", "find", "ls", "bash", "subagent", "ApproveGoal"],
		});
		expect(supervisor?.subagentOnlyExtensions).toEqual([expect.stringContaining("supervisor-runtime.ts")]);
		expect(supervisorSystemPrompt).toContain(GOAL_WORKER_AGENT);
		expect(supervisorSystemPrompt).toContain("async:false");
		expect(supervisorSystemPrompt).toContain("ApproveGoal");
		expect(definitions.has(GOAL_WORKER_AGENT)).toBe(false);
	});
});

describe("goal worker RPC", () => {
	it("starts from a fork, resumes retained context, and steers a live run", async () => {
		const events = new Events();
		const requests: any[] = [];
		replyToRpc(events, (request) => {
			requests.push(request);
			return { text: "ok", details: { asyncId: `run-${requests.length}` } };
		});

		await expect(startGoalSupervisor(events, "/repo", "start", true, "provider/worker")).resolves.toBe("run-1");
		await expect(resumeGoalSupervisor(events, "run-1", "continue")).resolves.toBe("run-2");
		await steerGoalSupervisor(events, "run-2", "report");
		await stopGoalSupervisor(events, "run-2");

		expect(requests[0]).toMatchObject({ method: "spawn", params: { agent: "goal-supervisor", cwd: "/repo", context: "fork", async: true, extensionBindings: { "pi-goals/1": { compactPlanning: true, workerModel: "provider/worker" } } } });
		expect(requests[1]).toMatchObject({ method: "resume", params: { id: "run-1", message: "continue" } });
		expect(requests[2]).toMatchObject({ method: "steer", params: { id: "run-2", message: "report", mode: "steer" } });
		expect(requests[3]).toMatchObject({ method: "stop", params: { id: "run-2" } });
		expect(terminalSteerError(new Error("Async run is completed"))).toBe(true);
	});

	it("reports active, idle, and incomplete status snapshots", async () => {
		for (const [snapshot, expected] of [
			[{ kind: "pi-subagents.async-status-snapshot", version: 1, omitted: { runs: 0, children: 0, byteLimitExceeded: false }, runs: [{ id: "worker", state: "running" }] }, "active"],
			[{ kind: "pi-subagents.async-status-snapshot", version: 1, omitted: { runs: 0, children: 0, byteLimitExceeded: false }, runs: [{ id: "worker", state: "complete", children: [{ id: "nested", state: "running" }] }] }, "active"],
			[{ kind: "pi-subagents.async-status-snapshot", version: 1, omitted: { runs: 0, children: 0, byteLimitExceeded: false }, runs: [{ id: "worker", state: "complete" }] }, "idle"],
			[{ kind: "pi-subagents.async-status-snapshot", version: 1, omitted: { runs: 1, children: 0, byteLimitExceeded: false }, runs: [] }, "unknown"],
		] as const) {
			const events = new Events();
			replyToRpc(events, () => ({ text: "status", asyncSnapshot: snapshot }));
			await expect(subagentWorkState(events)).resolves.toBe(expected);
		}
	});
});

describe("managed process status", () => {
	it("does not treat a missing process extension as idle", () => {
		expect(processWorkState(new Events())).toBe("unknown");
	});

	it("uses pi-processes live statuses", () => {
		for (const [status, expected] of [["finished", "idle"], ["running", "active"], ["terminate_timeout", "active"], ["new-status", "active"]] as const) {
			const events = new Events();
			events.on("processes:request:list", (raw) => {
				(raw as { reply(value: object[]): void }).reply([{ status }]);
			});
			expect(processWorkState(events)).toBe(expected);
		}
	});
});
