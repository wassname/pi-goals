import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { focusSupervisor, planHash, type SupervisorBinding, startSupervisor, supervisorRequest } from "../src/supervisor.js";

const binding: SupervisorBinding = { id: "pair", workerSession: "/worker.jsonl", supervisorSession: "/supervisor.jsonl", planPath: "/plan.md", workerPane: "w1:p1", supervisorPane: "w1:p2", everyTurns: 50, intervalMs: 3_600_000, compactTokens: 100_000 };
afterEach(() => vi.unstubAllEnvs());
describe("supervisor adapter", () => {
	it("fails visibly when the supervisor API is absent", async () => {
		const pi = { events: { emit() {} } } as unknown as ExtensionAPI;
		await expect(supervisorRequest(pi, "status")).rejects.toThrow("Load the plan-aware");
	});
	it("does not operate on a live Herdr session from outside Herdr", async () => {
		vi.stubEnv("HERDR_ENV", "");
		const exec = vi.fn();
		await expect(focusSupervisor({ exec } as unknown as ExtensionAPI, binding, "supervisor")).rejects.toThrow("Start Pi inside Herdr");
		expect(exec).not.toHaveBeenCalled();
	});
	it("does not spawn a duplicate when the recorded pane is unavailable", async () => {
		vi.stubEnv("HERDR_ENV", "1"); vi.stubEnv("HERDR_PANE_ID", "w1:p1");
		const exec = vi.fn(async () => ({ code: 1, stdout: "", stderr: '{"error":{"code":"pane_not_found","message":"Pane unavailable"}}' }));
		const pi = { exec, events: { emit(_name: string, request: any) { request.handled = true; request.resolve({ connected: false, binding, workerId: "worker" }); } }, getCommands: () => [{ name: "supervise", sourceInfo: { path: "/supervise.ts" } }], getAllTools: () => [{ name: "intercom", sourceInfo: { path: "/intercom.ts" } }] } as unknown as ExtensionAPI;
		const ctx = { cwd: "/project", sessionManager: { getSessionFile: () => "/worker.jsonl", getLeafId: () => "leaf" } } as unknown as ExtensionContext;
		await expect(startSupervisor(pi, ctx, binding.planPath, binding, vi.fn(), new AbortController().signal)).rejects.toThrow("/supervisor.jsonl");
		expect(exec.mock.calls).toHaveLength(1);
		expect(exec.mock.calls[0]).toEqual(["herdr", ["agent", "focus", "w1:p2"], expect.anything()]);
	});
	it("hashes quoted requirements without normalizing their literal checkbox syntax", () => {
		expect(planHash('Render "[x]"')).not.toBe(planHash('Render "[ ]"'));
	});
});
