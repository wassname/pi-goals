import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { approvalPath } from "../src/approval.js";
import { createMailbox, supervisorReady, workerSteersAfter } from "../src/mailbox.js";
import { registerVisibleSupervisor } from "../src/supervisor-session.js";

function setup(cwd: string, planPath: string, tokens: number | null = 10, onCompact: (options: any) => void = (options) => options.onComplete()) {
	const mailbox = createMailbox(cwd, "worker-session", "approval-1", planPath);
	vi.stubEnv("PI_GOALS_WORKER_ID", "worker-session");
	vi.stubEnv("PI_GOALS_OWNER_SESSION_ID", "worker-session");
	vi.stubEnv("PI_GOALS_PLAN_PATH", planPath);
	vi.stubEnv("PI_GOALS_APPROVAL_ID", "approval-1");
	vi.stubEnv("PI_GOALS_MAILBOX_PATH", mailbox.path);
	const hooks = new Map<string, any>();
	const tools = new Map<string, any>();
	const entries: any[] = [];
	const messages: string[] = [];
	let branch: any[] = [];
	let activeTools = ["read", "grep", "bash", "write", "edit"];
	const ctx = {
		cwd,
		getSystemPrompt: () => "base",
		getContextUsage: () => tokens === null ? undefined : ({ tokens }),
		compact: vi.fn(onCompact),
		sessionManager: { getEntries: () => entries, getBranch: () => branch, getSessionId: () => "supervisor-session" },
		ui: { notify: vi.fn() },
	};
	const pi = {
		on: (name: string, handler: any) => hooks.set(name, handler),
		registerTool: (tool: any) => tools.set(tool.name, tool),
		appendEntry: (customType: string, data: unknown) => entries.push({ type: "custom", customType, data }),
		sendUserMessage: (message: string) => messages.push(message),
		getActiveTools: () => activeTools,
		setActiveTools: (next: string[]) => { activeTools = next; },
	};
	registerVisibleSupervisor(pi as unknown as ExtensionAPI);
	return { activeTools: () => activeTools, branch: (value: any[]) => { branch = value; }, ctx, entries, hooks, mailbox, messages, tools };
}

afterEach(() => vi.unstubAllEnvs());

describe("visible supervisor session", () => {
	it("writes readiness only after removing writing tools", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "pi-goals-supervisor-"));
		try {
			const runtime = setup(cwd, join(cwd, ".pi/plan/worker-v1.md"));
			await runtime.hooks.get("session_start")({}, runtime.ctx);
			await new Promise((resolve) => setImmediate(resolve));
			expect(runtime.ctx.compact).not.toHaveBeenCalled();
			expect(supervisorReady(runtime.mailbox.path)).toBe(true);
			expect(runtime.activeTools()).toEqual(["read", "grep"]);
			expect(runtime.entries.at(-1)).toMatchObject({ customType: "pi-goals-visible-supervisor-v2" });
		} finally { rmSync(cwd, { recursive: true, force: true }); }
	});

	it("compacts a large planning fork before writing readiness", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "pi-goals-supervisor-"));
		try {
			let complete: (() => void) | undefined;
			const runtime = setup(cwd, join(cwd, ".pi/plan/worker-v1.md"), 20_001, (options) => { complete = options.onComplete; });
			await runtime.hooks.get("session_start")({}, runtime.ctx);
			await new Promise((resolve) => setImmediate(resolve));
			expect(runtime.ctx.compact).toHaveBeenCalledOnce();
			expect(supervisorReady(runtime.mailbox.path)).toBe(false);
			complete!();
			expect(supervisorReady(runtime.mailbox.path)).toBe(true);
		} finally { rmSync(cwd, { recursive: true, force: true }); }
	});

	it("does not become ready when initial compaction fails", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "pi-goals-supervisor-"));
		try {
			const runtime = setup(cwd, join(cwd, ".pi/plan/worker-v1.md"), null, (options) => options.onError(new Error("offline")));
			await runtime.hooks.get("session_start")({}, runtime.ctx);
			await new Promise((resolve) => setImmediate(resolve));
			expect(supervisorReady(runtime.mailbox.path)).toBe(false);
			expect(runtime.ctx.ui.notify).toHaveBeenCalledWith("Supervisor startup compaction failed: offline", "error");
		} finally { rmSync(cwd, { recursive: true, force: true }); }
	});

	it("writes a durable worker instruction", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "pi-goals-supervisor-"));
		try {
			const runtime = setup(cwd, join(cwd, "plan.md"));
			const steered = await runtime.tools.get("SteerWorker").execute("id", { instruction: "Run the saved verification." });
			expect(steered.isError).toBe(false);
			expect(workerSteersAfter(runtime.mailbox.path, 0)).toMatchObject([{ sequence: 1, instruction: "Run the saved verification." }]);
		} finally { rmSync(cwd, { recursive: true, force: true }); }
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
			runtime.branch([{ type: "message", message: { role: "user", content: [{ type: "text", text: "The worker stopped.\n\ntool calls with no result: none" }] } }]);
			const approved = await runtime.tools.get("ApproveGoal").execute("id", { goal: "make the file", verifyOutputPath: "verify.txt" }, undefined, undefined, runtime.ctx);
			expect(approved.isError).toBe(false);
			expect(existsSync(approvalPath(cwd, "worker-session", "make the file"))).toBe(true);
		} finally { rmSync(cwd, { recursive: true, force: true }); }
	});
});
