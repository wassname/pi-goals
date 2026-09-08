import { EventEmitter } from "node:events";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { expect, it, vi } from "vitest";
import { backgroundState } from "../src/background.js";

function api(tools: string[], processes?: unknown, subagents?: number) {
	const bus = new EventEmitter();
	if (processes !== undefined) bus.on("processes:request:list", request => request.reply(processes));
	if (subagents !== undefined) bus.on("subagents:rpc:v1:request", request => bus.emit(`subagents:rpc:v1:reply:${request.requestId}`, { requestId: request.requestId, success: true, data: { fleet: { version: 1, totalActive: subagents } } }));
	return { getAllTools: () => tools.map(name => ({ name })), events: { emit: (name: string, value: unknown) => bus.emit(name, value), on: (name: string, fn: (...args: any[]) => void) => { bus.on(name, fn); return () => { bus.off(name, fn); }; } } } as unknown as ExtensionAPI;
}

it("reports tracked running work, rather than equating idle agent with finished jobs", async () => {
	const active = await backgroundState(api(["process", "subagent"], [{ name: "generation", status: "running" }], 1));
	expect(active.quiet).toBe(false);
	expect(active.description).toContain("processes: 1 (generation)");
	expect(active.description).toContain("subagents: 1");
	const finished = await backgroundState(api(["process", "subagent"], [{ status: "exited" }], 0));
	expect(finished.quiet).toBe(true);
});

it("distinguishes missing providers from an unavailable installed tracker", async () => {
	expect((await backgroundState(api([]))).quiet).toBe(true);
	expect(await backgroundState(api(["process"]))).toMatchObject({ quiet: false, description: expect.stringContaining("processes: unknown") });
	vi.useFakeTimers();
	try {
		const unavailable = backgroundState(api(["subagent"]));
		await vi.advanceTimersByTimeAsync(2000);
		expect(await unavailable).toMatchObject({ quiet: false, description: expect.stringContaining("subagents: unknown") });
	} finally { vi.useRealTimers(); }
});
