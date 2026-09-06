import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { approvalPath, goalBlock, hashGoalBlock, repositoryState, writeApproval } from "../src/approval.js";

const openSupervisorPane = vi.fn(async () => "pane-2");
const closeSupervisorPane = vi.fn(async () => undefined);
vi.mock("../src/herdr.js", () => ({ openSupervisorPane, closeSupervisorPane }));
vi.mock("../src/intercom.js", () => ({
	registerGoalsIntercom: () => ({
		workerIntercomId: async () => "worker-intercom",
		waitForSupervisorReady: async () => {},
		announceSupervisorReady: async () => {},
	}),
}));

const { default: piGoalsExtension, isMainSession } = await import("../src/index.js");

function setup(selectChoices: Array<string | undefined>, editorChoices: Array<string | undefined> = []) {
	const cwd = mkdtempSync(join(tmpdir(), "pi-goals-flow-"));
	writeFileSync(join(cwd, ".gitignore"), ".pi/\n");
	execFileSync("git", ["init", "-q"], { cwd });
	execFileSync("git", ["add", ".gitignore"], { cwd });
	execFileSync("git", ["-c", "user.name=test", "-c", "user.email=test@example.com", "commit", "-qm", "initial"], { cwd });
	const commands = new Map<string, any>();
	const hooks = new Map<string, any>();
	const tools = new Map<string, any>();
	const entries: Array<{ type: string; customType: string; data: unknown }> = [];
	const messages: Array<{ content: string; display?: boolean }> = [];
	const notifications: string[] = [];
	const ctx = {
		cwd,
		hasUI: true,
		getSystemPrompt: () => "base prompt",
		sessionManager: {
			getSessionId: () => "session-a",
			getSessionFile: () => join(cwd, "session.jsonl"),
			getEntries: () => entries,
		},
		ui: {
			theme: { fg: (_kind: string, text: string) => text },
			setStatus: vi.fn(),
			setWidget: vi.fn(),
			notify: (text: string) => notifications.push(text),
			select: async () => selectChoices.shift(),
			editor: async () => editorChoices.shift(),
		},
	};
	const pi = {
		registerCommand: (name: string, command: any) => commands.set(name, command),
		on: (name: string, handler: any) => hooks.set(name, handler),
		appendEntry: (customType: string, data: unknown) => entries.push({ type: "custom", customType, data }),
		registerTool: (tool: any) => tools.set(tool.name, tool),
		sendMessage: (message: { content: string; display?: boolean }) => messages.push(message),
		sendUserMessage: (content: string) => messages.push({ content }),
	};
	piGoalsExtension(pi as unknown as ExtensionAPI);
	return { commands, ctx, cwd, entries, hooks, messages, notifications, tools };
}

function writePlan(cwd: string, content: string): string {
	const path = join(cwd, ".pi/plan/session-a-v1.md");
	mkdirSync(join(cwd, ".pi/plan"), { recursive: true });
	writeFileSync(path, content);
	return path;
}

function approvedPlan(cwd: string): string {
	return writePlan(cwd, "# Plan\n\n## Goals\n\n1. [ ] goal: make the file\n  - discriminator: output exists\n  - evidence:\n    - `result.txt`: contains ok\n\n## Log\n");
}

afterEach(() => {
	openSupervisorPane.mockClear();
	closeSupervisorPane.mockClear();
});

describe("/goals flow", () => {
	it("preserves drafts, records the interview, and keeps planning read-only", async () => {
		const flow = setup(["Refine"], ["Keep two columns."]);
		try {
			await flow.commands.get("goals").handler("first objective", flow.ctx);
			const first = writePlan(flow.cwd, "# Plan\n\n## Goals\n\n1. [ ] goal: preserve this\n\n## Interview\n");
			await flow.hooks.get("input")({ text: "Preserve column order.", source: "interactive" }, flow.ctx);
			await flow.hooks.get("agent_settled")({}, flow.ctx);
			expect(readFileSync(first, "utf8")).toContain("> Preserve column order.");
			expect(readFileSync(first, "utf8")).toContain("> Keep two columns.");
			expect(flow.messages.at(-1)?.content).toContain("Revise the plan at");
			expect((await flow.hooks.get("tool_call")({ toolName: "edit", input: { path: "README.md" } }, flow.ctx))?.block).toBe(true);

			await flow.commands.get("goals").handler("second objective", flow.ctx);
			expect(readFileSync(first, "utf8")).toContain("preserve this");
			expect(flow.messages.at(-1)?.content).toContain("session-a-v2.md");
		} finally {
			rmSync(flow.cwd, { recursive: true, force: true });
		}
	});

	it("forks a visible supervisor on Ready and keeps the main session as worker", async () => {
		const flow = setup(["Ready"]);
		try {
			await flow.commands.get("goals").handler("make the file", flow.ctx);
			const planPath = approvedPlan(flow.cwd);
			await flow.hooks.get("agent_settled")({}, flow.ctx);
			expect(openSupervisorPane).toHaveBeenCalledWith(expect.objectContaining({
				cwd: flow.cwd,
				sourceSessionFile: join(flow.cwd, "session.jsonl"),
				workerSessionId: "session-a",
				workerIntercomId: "worker-intercom",
				planPath,
			}));
			expect(flow.entries.at(-1)?.data).toMatchObject({ phase: "working", supervisorPaneId: "pane-2" });
			expect(flow.messages.at(-1)?.content).toBe("The plan is approved. Begin implementation as the worker.");
			const prompt = await flow.hooks.get("before_agent_start")({}, flow.ctx);
			expect(prompt.systemPrompt).toContain("implementation worker");
			expect(prompt.systemPrompt).toContain("stronger read-only supervisor");
		} finally {
			rmSync(flow.cwd, { recursive: true, force: true });
		}
	});

	it("closes the supervisor on clear but keeps the plan file", async () => {
		const flow = setup(["Ready"]);
		try {
			await flow.commands.get("goals").handler("make the file", flow.ctx);
			const planPath = approvedPlan(flow.cwd);
			await flow.hooks.get("agent_settled")({}, flow.ctx);
			await flow.commands.get("goals").handler("clear", flow.ctx);
			expect(closeSupervisorPane).toHaveBeenCalledWith("pane-2");
			expect(readFileSync(planPath, "utf8")).toContain("make the file");
			expect(flow.entries.at(-1)?.data).toMatchObject({ phase: null, supervisorPaneId: null, planVersion: null });
		} finally {
			rmSync(flow.cwd, { recursive: true, force: true });
		}
	});

	it("accepts only an approval for the exact clean commit and goal block", async () => {
		const flow = setup(["Ready"]);
		try {
			await flow.commands.get("goals").handler("make the file", flow.ctx);
			const planPath = approvedPlan(flow.cwd);
			await flow.hooks.get("agent_settled")({}, flow.ctx);
			const goal = "make the file";
			const plan = readFileSync(planPath, "utf8");
			const block = goalBlock(plan, goal)!;
			const repository = repositoryState(flow.cwd);
			const approvalId = (flow.entries.at(-1)?.data as { approvalId: string }).approvalId;
			writeApproval(approvalPath(flow.cwd, "session-a", goal), {
				version: 2, verdict: "accept", approvalId, goal, planPath,
				goalBlockHash: hashGoalBlock(block), repoRoot: repository.repoRoot,
				head: repository.head, tree: repository.tree, cleanWorktree: true,
				inspected: { plan: true, repository: true, evidence: true, verifyOutput: true },
				supervisor: { sessionId: "supervisor", runId: null }, timestamp: new Date().toISOString(),
			});
			const signed = await flow.tools.get("CompleteGoal").execute("id", { goal }, undefined, undefined, flow.ctx);
			expect(signed.isError).toBe(false);
			expect(readFileSync(planPath, "utf8")).toContain("1. [x] goal: make the file");
		} finally {
			rmSync(flow.cwd, { recursive: true, force: true });
		}
	});
});

describe("process role", () => {
	it("keeps subagent children and visible supervisors out of the worker extension", () => {
		expect(isMainSession(false)).toBe(true);
		expect(isMainSession(true)).toBe(false);
	});
});
