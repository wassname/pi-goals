import { describe, expect, it } from "vitest";
import workerRuntime from "../src/worker-runtime.js";

function setup(entries: object[], details: object = { compactor: "pi-vcc" }, compactError?: Error) {
	const hooks = new Map<string, any>();
	const appended: Array<{ type: string; data: unknown }> = [];
	const pi = {
		on: (name: string, handler: any) => hooks.set(name, handler),
		appendEntry: (type: string, data: unknown) => appended.push({ type, data }),
	};
	const ctx = {
		sessionManager: { getEntries: () => [...entries, ...appended.map(({ type, data }) => ({ type: "custom", customType: type, data }))] },
		compact: ({ customInstructions, onComplete, onError }: any) => {
			if (compactError) onError(compactError);
			else onComplete({ summary: "summary", firstKeptEntryId: "", tokensBefore: 1000, details, customInstructions });
		},
	};
	workerRuntime(pi as any);
	return { hooks, ctx, appended };
}

describe("goal-worker fork compaction", () => {
	it("requires pi-vcc before the first worker turn and records completion", async () => {
		const runtime = setup([]);
		await runtime.hooks.get("session_start")({}, runtime.ctx);
		expect(runtime.appended).toEqual([{ type: "pi-goals-worker-fork-prepared", data: { version: 1, compacted: true, compactor: "pi-vcc" } }]);
	});

	it("records when the exact fork is already too small to compact", async () => {
		const runtime = setup([], undefined, new Error("Nothing to compact (session too small)"));
		await runtime.hooks.get("session_start")({}, runtime.ctx);
		expect(runtime.appended).toEqual([{ type: "pi-goals-worker-fork-prepared", data: { version: 1, compacted: false, reason: "below-compactable-size" } }]);
	});

	it("does not prepare the retained worker again after resume", async () => {
		const runtime = setup([{ type: "custom", customType: "pi-goals-worker-fork-prepared" }]);
		await runtime.hooks.get("session_start")({}, runtime.ctx);
		expect(runtime.appended).toEqual([]);
	});

	it("fails if another compactor handled the fork", async () => {
		const runtime = setup([], { compactor: "other" });
		await expect(runtime.hooks.get("session_start")({}, runtime.ctx)).rejects.toThrow("not compacted by pi-vcc");
	});
});
