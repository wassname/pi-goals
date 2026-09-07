import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { approvalPath } from "../src/approval.js";
import { registerVisibleSupervisor } from "../src/supervisor-session.js";

function setup(cwd: string, planPath: string) {
	vi.stubEnv("PI_GOALS_WORKER_ID", "worker-session");
	vi.stubEnv("PI_GOALS_WORKER_INTERCOM_ID", "worker-intercom");
	vi.stubEnv("PI_GOALS_OWNER_SESSION_ID", "worker-session");
	vi.stubEnv("PI_GOALS_PLAN_PATH", planPath);
	vi.stubEnv("PI_GOALS_APPROVAL_ID", "approval-1");
	const hooks = new Map<string, any>();
	const tools = new Map<string, any>();
	const entries: any[] = [];
	const paired: Array<{ workerIntercomId: string; goal: string }> = [];
	const messages: string[] = [];
	let branch: any[] = [];
	const ctx = {
		cwd,
		getSystemPrompt: () => "base",
		getContextUsage: () => ({ tokens: 10 }),
		compact: vi.fn((options: any) => options.onComplete()),
		sessionManager: {
			getEntries: () => entries,
			getBranch: () => branch,
			getSessionId: () => "supervisor-session",
		},
		ui: { notify: vi.fn() },
	};
	const pi = {
		events: {
			on() {},
			emit(name: string, request: any) {
				if (name !== "pi-supervise:pair:v1") return;
				paired.push({ workerIntercomId: request.workerIntercomId, goal: request.goal });
				request.resolve();
			},
		},
		on: (name: string, handler: any) => hooks.set(name, handler),
		registerTool: (tool: any) => tools.set(tool.name, tool),
		appendEntry: (customType: string, data: unknown) => entries.push({ type: "custom", customType, data }),
		sendUserMessage: (message: string) => messages.push(message),
	};
	registerVisibleSupervisor(pi as unknown as ExtensionAPI);
	return { branch: (value: any[]) => { branch = value; }, ctx, entries, hooks, messages, paired, tools };
}

afterEach(() => vi.unstubAllEnvs());

describe("visible supervisor session", () => {
	it("pairs from session startup before asking the supervisor to work", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "pi-goals-supervisor-"));
		try {
			const runtime = setup(cwd, join(cwd, ".pi/plan/worker-v1.md"));
			await runtime.hooks.get("session_start")({}, runtime.ctx);
			await new Promise((resolve) => setImmediate(resolve));
			expect(runtime.ctx.compact).not.toHaveBeenCalled();
			expect(runtime.entries.at(-1)).toMatchObject({ customType: "pi-goals-visible-supervisor-v1" });
			expect(runtime.paired).toEqual([{ workerIntercomId: "worker-intercom", goal: join(cwd, ".pi/plan/worker-v1.md") }]);
			expect(runtime.messages).toEqual(["Supervision is paired. Inspect the worker and give its next concrete instruction."]);
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("does not pair twice across session startup and later turns", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "pi-goals-supervisor-"));
		try {
			const runtime = setup(cwd, join(cwd, ".pi/plan/worker-v1.md"));
			await runtime.hooks.get("session_start")({}, runtime.ctx);
			await new Promise((resolve) => setImmediate(resolve));
			await runtime.hooks.get("before_agent_start")({}, runtime.ctx);
			expect(runtime.paired).toHaveLength(1);
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("records approval only from a stopped view with evidence and no active work", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "pi-goals-supervisor-"));
		try {
			writeFileSync(join(cwd, ".gitignore"), ".pi/\n");
			writeFileSync(join(cwd, "verify.txt"), "PASS\n");
			execFileSync("git", ["init", "-q"], { cwd });
			execFileSync("git", ["add", ".gitignore", "verify.txt"], { cwd });
			execFileSync("git", ["-c", "user.name=test", "-c", "user.email=test@example.com", "commit", "-qm", "initial"], { cwd });
			const planPath = join(cwd, ".pi/plan/worker-v1.md");
			execFileSync("mkdir", ["-p", join(cwd, ".pi/plan")]);
			writeFileSync(planPath, "# Plan\n\n## Goals\n\n1. [ ] goal: make the file\n  - discriminator: output exists\n  - evidence:\n    - `result.txt`: contains ok\n\n## Log\n");
			const runtime = setup(cwd, planPath);
			runtime.branch([{
				type: "message",
				message: { role: "user", content: [{ type: "text", text: "The worker stopped.\n\ntool calls with no result: none\nchild pi processes still running: none" }] },
			}]);
			const approved = await runtime.tools.get("ApproveGoal").execute("id", {
				goal: "make the file",
				verifyOutputPath: "verify.txt",
			}, undefined, undefined, runtime.ctx);
			expect(approved.isError).toBe(false);
			expect(existsSync(approvalPath(cwd, "worker-session", "make the file"))).toBe(true);
			const missingOutput = await runtime.tools.get("ApproveGoal").execute("id", {
				goal: "make the file", verifyOutputPath: "missing.txt",
			}, undefined, undefined, runtime.ctx);
			expect(missingOutput.isError).toBe(true);
			expect(missingOutput.content[0].text).toContain("verification-output");
			writeFileSync(planPath, "# Plan\n\n## Goals\n\n1. [ ] goal: make the file\n  - evidence:\n    - \n  - tasks:\n    - write result.txt\n");
			const missingEvidence = await runtime.tools.get("ApproveGoal").execute("id", {
				goal: "make the file", verifyOutputPath: "verify.txt",
			}, undefined, undefined, runtime.ctx);
			expect(missingEvidence.isError).toBe(true);
			expect(missingEvidence.content[0].text).toContain("nonblank evidence entry");
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("rejects approval while the worker view has an unfinished tool call", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "pi-goals-supervisor-"));
		try {
			const planPath = join(cwd, "plan.md");
			writeFileSync(planPath, "1. [ ] goal: wait\n  - evidence:\n    - result\n");
			const runtime = setup(cwd, planPath);
			runtime.branch([{
				type: "message",
				message: { role: "user", content: [{ type: "text", text: "The worker stopped.\n\ntool calls with no result: bash\nchild pi processes still running: none" }] },
			}]);
			const rejected = await runtime.tools.get("ApproveGoal").execute("id", {
				goal: "wait", verifyOutputPath: "verify.txt",
			}, undefined, undefined, runtime.ctx);
			expect(rejected.isError).toBe(true);
			expect(rejected.content[0].text).toContain("bash");
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});
});
