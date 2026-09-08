import { type ExtensionAPI, type ExtensionContext, SessionManager } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { focusSupervisor, planHash, type SupervisorBinding, type SupervisorController, startSupervisor, supervisorResourceArgs } from "../src/supervisor.js";

const binding: SupervisorBinding = { id: "pair", workerSession: "/worker.jsonl", supervisorSession: "/supervisor.jsonl", planPath: "/plan.md", workerPane: "w1:p1", supervisorPane: "w1:p2", everyTurns: 50, intervalMs: 3_600_000, compactTokens: 100_000 };
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });
describe("supervisor adapter", () => {
 it("reuses explicit resource choices without adding companion packages or copying mode/model/auth", () => {
   expect(supervisorResourceArgs(["--mode", "rpc", "--model", "expensive", "--api-key", "not-forwarded", "--no-extensions", "-e", "/package", "--skill", "/skill", "prompt"])).toEqual(["--no-extensions", "-e", "/package", "--skill", "/skill"]);
   expect(supervisorResourceArgs([])).toEqual([]);
 });
	it.each([
		["--no-extensions", "--no-skills", "--no-prompt-templates"],
		["-ne", "-ns", "-np"],
	])("preserves equivalent disabling flags in the generated launch: %s %s %s", async (extensions, skills, prompts) => {
		const resources = [extensions, "-e", "/package", skills, prompts];
		const expected = ["--no-extensions", "-e", "/package", "--no-skills", "--no-prompt-templates"];
		expect(supervisorResourceArgs(resources)).toEqual(expected);
		vi.stubEnv("HERDR_ENV", "1"); vi.stubEnv("HERDR_PANE_ID", "w1:p1");
		const existing = { ...binding, supervisorPane: undefined };
		const appendCustomEntry = vi.fn();
		vi.spyOn(SessionManager, "open").mockReturnValue({ appendCustomEntry } as unknown as SessionManager);
		const exec = vi.fn(async (_command: string, args: string[]) => ({ code: 0, stderr: "", stdout: args[0] === "pane" ? JSON.stringify({ result: { pane: { pane_id: "w1:p2" } } }) : "{}" }));
		const pi = { exec } as unknown as ExtensionAPI;
		const controller = { status: async () => ({ connected: false, binding: existing, workerId: "worker" }), attached: async () => binding } as unknown as SupervisorController;
		const ctx = { cwd: "/project", sessionManager: { getSessionFile: () => binding.workerSession, getLeafId: () => "leaf" } } as unknown as ExtensionContext;
		const originalArgv = process.argv;
		try {
			process.argv = [originalArgv[0], originalArgv[1], "--mode", "rpc", ...resources];
			await startSupervisor(pi, controller, ctx, binding.planPath, existing, vi.fn(), new AbortController().signal);
		} finally { process.argv = originalArgv; }
		expect(exec.mock.calls[1]).toEqual(["herdr", ["agent", "start", "supervisor-pair", "--kind", "pi", "--pane", "w1:p2", "--", "--session", binding.supervisorSession, ...expected], expect.anything()]);
		expect(appendCustomEntry).toHaveBeenCalledOnce();
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
		await expect(startSupervisor(pi, { status: async () => ({ connected: false, binding, workerId: "worker" }) } as SupervisorController, ctx, binding.planPath, binding, vi.fn(), new AbortController().signal)).rejects.toThrow("/supervisor.jsonl");
		expect(exec.mock.calls).toHaveLength(1);
		expect(exec.mock.calls[0]).toEqual(["herdr", ["agent", "focus", "w1:p2"], expect.anything()]);
	});
	it("hashes quoted requirements without normalizing their literal checkbox syntax", () => {
		expect(planHash('Render "[x]"')).not.toBe(planHash('Render "[ ]"'));
	});
});
