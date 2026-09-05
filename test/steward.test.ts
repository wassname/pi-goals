import { describe, expect, it, vi } from "vitest";
import {
	checkpointReview,
	parseStewardDecision,
	readyReview,
	registerStewardAgent,
	runStewardReview,
	signoffReview,
	startSteward,
	stewardSystemPrompt,
} from "../src/steward.js";

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

function completion(runId: string, verdict: "let_run" | "redirect" | "accept" | "reject" = "accept") {
	return {
		runId,
		results: [{ success: true, structuredOutput: { verdict, summary: "Observed the cited artifact." } }],
	};
}

describe("goal steward registration", () => {
	it("registers one read-only runtime agent through pi-subagents", () => {
		const events = new Events();
		let definition: Record<string, unknown> | undefined;
		events.on("pi-subagents:runtime-agent-register:v1", (raw) => {
			const request = raw as { definition: Record<string, unknown>; result?: unknown };
			definition = request.definition;
			request.result = { ok: true, registration: { dispose() {} } };
		});

		registerStewardAgent(events, "provider/cheap-model");

		expect(definition?.model).toBe("provider/cheap-model");
		expect(definition?.tools).toEqual(["read", "grep", "find", "ls", "contact_supervisor"]);
		expect(definition?.excludeTools).toEqual(expect.arrayContaining(["bash", "edit", "write", "subagent"]));
		expect(definition?.inheritProjectContext).toBe(false);
		expect(stewardSystemPrompt).toContain("Read the complete plan from disk every time");
		expect(stewardSystemPrompt).toContain("Call structured_output as soon as the evidence is sufficient");
	});

	it("fails clearly when pi-subagents is absent", () => {
		expect(() => registerStewardAgent(new Events(), null)).toThrow("pi-subagents is not installed or not ready");
	});

	it("reserves accept and reject for sign-off", () => {
		expect(readyReview("plan.md")).toContain("return only let_run or redirect");
		expect(checkpointReview("plan.md", 8)).toContain("return only let_run or redirect");
		expect(signoffReview("plan.md", "goal")).toContain("Return accept only");
	});
});

describe("goal steward RPC", () => {
	it("starts a detached structured child", async () => {
		const events = new Events();
		let request: any;
		events.on("subagents:rpc:v1:request", (raw) => {
			request = raw;
			events.emit(`subagents:rpc:v1:reply:${request.requestId}`, { success: true, data: { text: "started", details: { asyncId: "run-1" } } });
		});

		await expect(startSteward(events, "/repo", "review now")).resolves.toBe("run-1");
		expect(request.method).toBe("spawn");
		expect(request.params).toMatchObject({ agent: "goal-steward", cwd: "/repo", context: "fresh", async: true, task: "review now" });
		expect(request.params.outputSchema.required).toEqual(["verdict", "summary"]);
	});

	it("resumes the same lineage and accepts only its exact completion", async () => {
		const events = new Events();
		let request: any;
		events.on("subagents:rpc:v1:request", (raw) => {
			request = raw;
			events.emit(`subagents:rpc:v1:reply:${request.requestId}`, { success: true, data: { text: "resumed", details: { asyncId: "run-2" } } });
			queueMicrotask(() => {
				events.emit("subagent:async-complete", completion("other-run", "reject"));
				events.emit("subagent:async-complete", completion("run-2"));
			});
		});

		const review = await runStewardReview(events, "/repo", "run-1", "sign off");
		expect(request.method).toBe("resume");
		expect(request.params).toEqual({ id: "run-1", message: "sign off" });
		expect(review).toEqual({ runId: "run-2", decision: { verdict: "accept", summary: "Observed the cited artifact." } });
	});

	it("does not lose a completion emitted before the RPC reply", async () => {
		const events = new Events();
		events.on("subagents:rpc:v1:request", (raw) => {
			const request = raw as { requestId: string };
			events.emit("subagent:async-complete", completion("run-fast"));
			events.emit(`subagents:rpc:v1:reply:${request.requestId}`, { success: true, data: { text: "started", details: { asyncId: "run-fast" } } });
		});

		await expect(runStewardReview(events, "/repo", null, "review")).resolves.toMatchObject({ runId: "run-fast", decision: { verdict: "accept" } });
	});

	it("fails closed when the exact child does not complete", async () => {
		vi.useFakeTimers();
		try {
			const events = new Events();
			events.on("subagents:rpc:v1:request", (raw) => {
				const request = raw as { requestId: string };
				events.emit(`subagents:rpc:v1:reply:${request.requestId}`, { success: true, data: { text: "started", details: { asyncId: "run-stuck" } } });
			});
			const review = runStewardReview(events, "/repo", null, "review", undefined, 1_000);
			const rejected = expect(review).rejects.toThrow("timed out after 1s");
			await vi.advanceTimersByTimeAsync(1_000);
			await rejected;
		} finally {
			vi.useRealTimers();
		}
	});
});

describe("steward verdict parsing", () => {
	it("requires the fields for redirect and reject", () => {
		expect(() => parseStewardDecision(completion("run", "redirect"))).toThrow("redirect omitted nextAction");
		expect(() => parseStewardDecision(completion("run", "reject"))).toThrow("rejection omitted missingEvidence");
	});
});
