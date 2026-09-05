import { describe, expect, it } from "vitest";
import {
	processWorkState,
	registerGoalWorker,
	resumeGoalWorker,
	startGoalWorker,
	steerGoalWorker,
	subagentWorkState,
	workerSystemPrompt,
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

describe("goal worker registration", () => {
	it("registers one retained implementation worker", () => {
		const events = new Events();
		let definition: Record<string, unknown> | undefined;
		events.on("pi-subagents:runtime-agent-register:v1", (raw) => {
			const request = raw as { definition: Record<string, unknown>; result?: unknown };
			definition = request.definition;
			request.result = { ok: true, registration: { dispose() {} } };
		});

		registerGoalWorker(events, "provider/cheap-model");

		expect(definition?.model).toBe("provider/cheap-model");
		expect(definition?.defaultContext).toBe("fork");
		expect(definition?.defaultProgress).toBe(true);
		expect(definition?.allowNestedSubagents).toBe(true);
		expect(definition?.subagentOnlyExtensions).toEqual([
			expect.stringContaining("pi-vcc"),
			expect.stringContaining("worker-runtime.ts"),
		]);
		expect(workerSystemPrompt).toContain("main Pi agent is the research supervisor");
	});

	it("fails clearly when pi-subagents is absent", () => {
		expect(() => registerGoalWorker(new Events(), null)).toThrow("pi-subagents is not installed or not ready");
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

		await expect(startGoalWorker(events, "/repo", "start")).resolves.toBe("run-1");
		await expect(resumeGoalWorker(events, "run-1", "continue")).resolves.toBe("run-2");
		await steerGoalWorker(events, "run-2", "report");

		expect(requests[0]).toMatchObject({ method: "spawn", params: { agent: "goal-worker", cwd: "/repo", context: "fork", async: true } });
		expect(requests[1]).toMatchObject({ method: "resume", params: { id: "run-1", message: "continue" } });
		expect(requests[2]).toMatchObject({ method: "steer", params: { id: "run-2", message: "report", mode: "steer" } });
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
		const events = new Events();
		events.on("processes:request:list", (raw) => {
			(raw as { reply(value: object[]): void }).reply([{ status: "terminate_timeout" }]);
		});
		expect(processWorkState(events)).toBe("active");
	});
});
