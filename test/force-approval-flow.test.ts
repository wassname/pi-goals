import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { expect, it, vi } from "vitest";
import { approvalPath, readApproval } from "../src/approval.js";
import { registerWorker as goals } from "../src/index.js";
import { registerVisibleSupervisor } from "../src/supervisor-session.js";
import { pairedIntercomFixture } from "./paired-intercom-fixture.js";

const goal = "inspect outputs";
const reason = "Inspected preserved notebook edits and historical outputs; unrelated to this goal.";
const settle = () => new Promise(resolve => setImmediate(resolve));

async function setup() {
	const cwd = mkdtempSync(join(tmpdir(), "goals-force-approval-"));
	const git = (...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
	writeFileSync(join(cwd, "verify.txt"), "PASS: actual output checked\n");
	writeFileSync(join(cwd, "notebook.py"), "original\n");
	git("init", "-q"); git("add", ".");
	git("-c", "user.name=test", "-c", "user.email=test@example.com", "commit", "-qm", "verified output");
	const head = git("rev-parse", "HEAD");
	const planPath = join(cwd, ".pi/plan/worker-v1.md");
	mkdirSync(join(cwd, ".pi/plan"), { recursive: true });
	const plan = `1. [ ] goal: ${goal}\n  - evidence: verify.txt\n\n## Log\n`;
	writeFileSync(planPath, plan);
	const wire = pairedIntercomFixture();
	function runtime(role: "worker" | "supervisor") {
		const entries: any[] = role === "worker" ? [{ type: "custom", customType: "pi-goals-state", data: { phase: "working", approvalId: "force-binding", planVersion: 1, supervisorPaneId: "fixture-only" } }] : [];
		const branch: any[] = [];
		const hooks = new Map<string, any>();
		const tools = new Map<string, any>();
		const ctx = {
			cwd, hasUI: true, isIdle: vi.fn(() => true), model: { provider: "test", id: "model" },
			modelRegistry: { find: (provider: string, id: string) => ({ provider, id }) },
			getSystemPrompt: () => "base", getContextUsage: () => ({ tokens: 10 }),
			sessionManager: { getSessionId: () => role, getSessionFile: () => join(cwd, `${role}.jsonl`), getEntries: () => entries, getBranch: () => [...entries, ...branch] },
			ui: { notify: vi.fn(), setWidget: vi.fn(), setStatus: vi.fn(), theme: { fg: (_kind: string, text: string) => text } },
		};
		const pi = {
			events: wire[role].events, getAllTools: vi.fn((): any[] => []), getActiveTools: () => ["read", "ApproveGoal", "SteerWorker"], setActiveTools: () => {},
			on: (name: string, fn: any) => { const prior = hooks.get(name); hooks.set(name, async (...args: any[]) => { await prior?.(...args); return fn(...args); }); },
			registerTool: (tool: any) => tools.set(tool.name, tool), registerCommand: () => {}, setModel: async () => true,
			appendEntry: (customType: string, data: unknown) => entries.push({ type: "custom", customType, data }),
			sendUserMessage: (text: string) => {
				const message = { role: "user", content: [{ type: "text", text }] };
				branch.push({ type: "message", message });
				void hooks.get("message_start")?.({ message });
			},
		};
		(role === "worker" ? goals : registerVisibleSupervisor)(pi as unknown as ExtensionAPI);
		return { pi, ctx, hooks, branch, tools };
	}
	const worker = runtime("worker");
	vi.stubEnv("PI_GOALS_WORKER_ID", "worker"); vi.stubEnv("PI_GOALS_OWNER_SESSION_ID", "worker");
	vi.stubEnv("PI_GOALS_APPROVAL_ID", "force-binding"); vi.stubEnv("PI_GOALS_PLAN_PATH", planPath);
	const supervisor = runtime("supervisor");
	await worker.hooks.get("session_start")({}, worker.ctx);
	await supervisor.hooks.get("session_start")({}, supervisor.ctx);
	await settle(); await settle();
	writeFileSync(join(cwd, "notebook.py"), "preserved user edit\n");
	writeFileSync(join(cwd, "historical output.txt"), "historical result\n");
	const approve = (params: object = { force: true, reason }) => supervisor.tools.get("ApproveGoal").execute("approve", { goal, verifyOutputPath: "verify.txt", ...params }, undefined, undefined, supervisor.ctx);
	const complete = () => worker.tools.get("CompleteGoal").execute("complete", { goal }, undefined, undefined, worker.ctx);
	return {
		cwd, git, head, planPath, plan, worker, supervisor, approve, complete,
		checkpoint: approvalPath(cwd, "worker", goal),
		close: async () => { await worker.hooks.get("session_shutdown")(); await supervisor.hooks.get("session_shutdown")(); vi.unstubAllEnvs(); rmSync(cwd, { recursive: true, force: true }); },
	};
}

it("force ApproveGoal -> CompleteGoal accepts only the reviewed dirty state without committing or modifying it", async () => {
	const flow = await setup();
	try {
		expect((await flow.approve({})).isError).toBe(true);
		for (const reason of [undefined, "", "  "]) expect((await flow.approve({ force: true, reason })).content[0].text).toContain("nonempty reason");
		expect(existsSync(flow.checkpoint)).toBe(false);
		const status = flow.git("status", "--porcelain=v1");
		expect((await flow.approve()).isError).toBe(false);
		const record = readApproval(flow.checkpoint)!;
		expect(record.cleanWorktree).toBe(false);
		expect(record.force?.reason).toBe(reason);
		expect(record.force?.worktree.status).toContain("?? historical output.txt\0");
		expect(record.force?.worktree.files).toEqual(expect.arrayContaining([
			expect.objectContaining({ path: "notebook.py", kind: "file", contentHash: expect.stringMatching(/^[a-f0-9]{64}$/) }),
			expect.objectContaining({ path: "historical output.txt", kind: "file", contentHash: expect.stringMatching(/^[a-f0-9]{64}$/) }),
		]));
		expect((await flow.complete()).isError).toBe(false);
		expect(readFileSync(flow.planPath, "utf8")).toContain(`[x] goal: ${goal}`);
		expect(readFileSync(join(flow.cwd, "notebook.py"), "utf8")).toBe("preserved user edit\n");
		expect(readFileSync(join(flow.cwd, "historical output.txt"), "utf8")).toBe("historical result\n");
		expect(flow.git("rev-parse", "HEAD")).toBe(flow.head);
		expect(flow.git("status", "--porcelain=v1")).toBe(status);
		console.log("Force UAT: paired real handlers accepted unchanged tracked + untracked dirty content; Git HEAD and user files stayed unchanged.");
	} finally { await flow.close(); }
});

it("keeps ordinary clean approval unchanged and rechecks runtime state at forced completion", async () => {
	const flow = await setup();
	try {
		expect((await flow.approve()).isError).toBe(false);
		flow.worker.pi.getAllTools.mockReturnValue([{ name: "process" }]);
		expect((await flow.complete()).isError).toBe(true); // Installed tracker is now unavailable.
		flow.worker.pi.getAllTools.mockReturnValue([]);
		writeFileSync(join(flow.cwd, "notebook.py"), "original\n");
		rmSync(join(flow.cwd, "historical output.txt"));
		expect((await flow.complete()).isError).toBe(true); // Cleaning up also changes the accepted state.
		expect((await flow.approve({})).isError).toBe(false);
		expect(readApproval(flow.checkpoint)?.force).toBeUndefined();
		expect((await flow.complete()).isError).toBe(false);
	} finally { await flow.close(); }
});

it.each(["tracked content", "untracked content", "new untracked", "deleted untracked", "index only", "index contents", "rename", "HEAD", "goal"])("invalidates forced approval after changed %s", async change => {
	const flow = await setup();
	try {
		expect((await flow.approve()).isError).toBe(false);
		if (change === "index contents") {
			flow.git("add", "notebook.py");
			writeFileSync(join(flow.cwd, "notebook.py"), "separate worktree\n");
			expect((await flow.approve()).isError).toBe(false);
		}
		const status = flow.git("status", "--porcelain=v1");
		if (change === "tracked content") writeFileSync(join(flow.cwd, "notebook.py"), "changed user edits\n");
		if (change === "untracked content") writeFileSync(join(flow.cwd, "historical output.txt"), "changed old output\n");
		if (change === "new untracked") writeFileSync(join(flow.cwd, "another.txt"), "new");
		if (change === "deleted untracked") rmSync(join(flow.cwd, "historical output.txt"));
		if (change === "index only") flow.git("add", "notebook.py");
		if (change === "index contents") {
			writeFileSync(join(flow.cwd, "notebook.py"), "different staged bytes\n");
			flow.git("add", "notebook.py");
			writeFileSync(join(flow.cwd, "notebook.py"), "separate worktree\n");
			expect(flow.git("status", "--porcelain=v1")).toBe(status);
		}
		if (change === "rename") renameSync(join(flow.cwd, "notebook.py"), join(flow.cwd, "renamed.py"));
		if (change === "HEAD") flow.git("-c", "user.name=test", "-c", "user.email=test@example.com", "commit", "--allow-empty", "-qm", "new head");
		if (change === "goal") writeFileSync(flow.planPath, flow.plan.replace("evidence: verify.txt", "evidence: different.txt"));
		if (change.endsWith(" content")) expect(flow.git("status", "--porcelain=v1")).toBe(status);
		expect((await flow.complete()).isError).toBe(true);
		expect(readFileSync(flow.planPath, "utf8")).toContain(`[ ] goal: ${goal}`);
	} finally { await flow.close(); }
});

it("does not approve while the worker start status is current", async () => {
	const flow = await setup();
	try {
		flow.worker.ctx.isIdle.mockReturnValue(false);
		await flow.worker.hooks.get("agent_start")({}, flow.worker.ctx);
		const response = await flow.approve();
		expect(response.isError).toBe(true);
		expect(response.content[0].text).toContain("starting or running");
	} finally { await flow.close(); }
});

it.each(["evidence", "verification", "tool call", "unknown tracker", "active tracker"])("force does not bypass the %s gate", async gate => {
	const flow = await setup();
	try {
		if (gate === "evidence") writeFileSync(flow.planPath, flow.plan.replace("evidence: verify.txt", "evidence: (empty until sign-off)"));
		if (gate === "verification") writeFileSync(join(flow.cwd, "verify.txt"), "");
		if (gate === "tool call") flow.worker.branch.push({ type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: "pending", name: "edit" }] } });
		if (gate.endsWith("tracker")) {
			flow.worker.pi.getAllTools.mockReturnValue([{ name: "process" }]);
			if (gate === "active tracker") {
				const emit = flow.worker.pi.events.emit;
				flow.worker.pi.events.emit = (name, request) => { if (name === "processes:request:list") { request.reply([{ status: "running", name: "existing-job" }]); return true; } return emit(name, request); };
			}
		}
		await flow.worker.hooks.get("agent_settled")({}, flow.worker.ctx); await settle();
		const response = await flow.approve();
		expect(response.isError).toBe(true);
		expect(existsSync(flow.checkpoint)).toBe(false);
		if (gate.endsWith("tracker")) expect(response.content[0].text).toContain("background work");
		if (gate === "tool call") expect(response.content[0].text).toContain("work is active: edit");
	} finally { await flow.close(); }
});
