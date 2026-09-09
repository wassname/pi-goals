import { execFileSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import piGoalsExtension from "../src/index.js";

vi.mock("../src/internal/supervisor/index.js", () => ({ default: () => ({ pause() {}, reconnect: async () => {}, status: async () => ({ connected: false, activity: "inactive" }) }) }));
const judgeRun = vi.hoisted(() => ({ output: "", beforeReply: undefined as (() => void) | undefined, calls: [] as string[][] }));
vi.mock("node:child_process", async (original) => {
	const actual = await original<typeof import("node:child_process")>();
	return { ...actual, spawn: (_command: string, args: string[]) => {
		judgeRun.calls.push(args);
		const proc = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter(), kill() {} });
		queueMicrotask(() => { judgeRun.beforeReply?.(); proc.stdout.emit("data", judgeRun.output); proc.emit("close", 0); });
		return proc;
	} };
});

function setup(
	selectChoices: Array<string | undefined>,
	editorChoices: Array<string | undefined> = [],
	editPlan?: () => Promise<string | undefined>,
) {
	const cwd = mkdtempSync(join(tmpdir(), "pi-goals-flow-"));
	const commands = new Map<string, any>();
	const hooks = new Map<string, any>();
	const tools = new Map<string, any>();
	const entries: Array<{ type: string; customType: string; data?: unknown; details?: unknown; content?: string }> = [];
	const events: string[] = [];
	const messages: Array<{ content: string; display?: boolean; customType?: string }> = [];
	const busHandlers = new Map<string, Set<(value: unknown) => unknown>>();
	const bus = {
		on(name: string, handler: (value: unknown) => unknown) {
			const handlers = busHandlers.get(name) ?? new Set();
			handlers.add(handler);
			busHandlers.set(name, handlers);
			return () => handlers.delete(handler);
		},
		emit(name: string, value: unknown) {
			for (const handler of busHandlers.get(name) ?? []) void handler(value);
		},
	};
	const ctx = {
		cwd,
		model: { provider: "offline", id: "test" },
		modelRegistry: { find: (provider: string, id: string) => ({ provider, id }) },
		hasUI: true,
		isIdle: () => true,
		abort: vi.fn(),
		sessionManager: { getSessionId: () => "session-a", getSessionFile: () => join(cwd, "session-a.jsonl"), getEntries: () => entries, getBranch: () => entries },
		ui: {
			theme: { fg: (_kind: string, text: string) => text },
			setStatus: vi.fn(),
			setWidget: vi.fn(),
			notify: vi.fn(),
			select: async () => {
				events.push("select");
				return selectChoices.shift();
			},
			editor: async () => {
				events.push("editor");
				return editPlan ? editPlan() : editorChoices.shift();
			},
		},
	};
	let active = ["read", "write", "edit", "bash", "CompleteGoal", "RequestPlanReview"];
	const pi = {
		getActiveTools: () => active,
		setActiveTools: (names: string[]) => { active = names; },
		setModel: vi.fn(async (model: { provider: string; id: string }) => { const previousModel = ctx.model; ctx.model = model; await hooks.get("model_select")?.({ model, previousModel, source: "set" }, ctx); return true; }),
		registerCommand: (name: string, command: any) => commands.set(name, command),
		on: (name: string, handler: any) => { const previous = hooks.get(name); hooks.set(name, async (...args: any[]) => { const prior = await previous?.(...args); return await handler(...args) ?? prior; }); },
		appendEntry: (customType: string, data: unknown) => entries.push({ type: "custom", customType, data }),
		registerTool: (tool: any) => tools.set(tool.name, tool),
		events: bus,
		sendMessage: (message: { content: string; display?: boolean; customType?: string }) => {
			events.push("display");
			messages.push(message);
		},
		sendUserMessage: (message: string) => messages.push({ content: message }),
	};
	piGoalsExtension(pi as unknown as ExtensionAPI);
	return { pi, bus, commands, ctx, cwd, entries, events, hooks, messages, tools };
}

async function promptReminder(flow: ReturnType<typeof setup>) {
	const result = await flow.hooks.get("before_agent_start")({}, flow.ctx);
	if (result?.message) flow.entries.push({ type: "custom_message", ...result.message });
	await flow.hooks.get("context")({ messages: [] }, flow.ctx);
	return result?.message;
}

async function settleDraft(flow: ReturnType<typeof setup>) {
	await flow.tools.get("RequestPlanReview").execute("", {}, undefined, undefined, flow.ctx);
	await flow.hooks.get("agent_settled")({}, flow.ctx);
}

describe("/goals recovery", () => {
	it("help, status and invalid recovery arguments never start a plan", async () => {
		const f = setup([]);
		try {
			for (const text of ["help", "status", "stop now", "exit now", "reconnect now", "resume now", "--unknown", "connect", "reconect"]) await f.commands.get("goals").handler(text, f.ctx);
			expect(f.messages).toHaveLength(0);
			expect(f.entries.filter(e => e.customType === "pi-goals-state")).toHaveLength(0);
		} finally { rmSync(f.cwd, { recursive: true, force: true }); }
	});

	it.each(["stop", "exit"])("%s keeps the draft, exits the gate and persists through reload and chat", async command => {
		const f = setup([]);
		try {
			await f.commands.get("goals").handler("plan recovery fixture", f.ctx);
			const path = join(f.cwd, ".pi/plan/session-a-v1.md");
			writeFileSync(path, "1. [ ] goal: retain this draft\n");
			await f.commands.get("goals").handler(command, f.ctx);
			const count = f.messages.length;
			await f.hooks.get("session_start")({}, f.ctx);
			await f.hooks.get("input")({ text: "ordinary chat", source: "interactive" }, f.ctx);
			await f.hooks.get("agent_settled")({}, f.ctx);
			await f.hooks.get("session_compact")({}, f.ctx);
			expect(await f.hooks.get("before_agent_start")({}, f.ctx)).toBeUndefined();
			expect(f.messages).toHaveLength(count);
			expect(await f.hooks.get("input")({ text: "Process finished", source: "extension" }, f.ctx)).toBeUndefined();
			expect(await f.hooks.get("input")({ text: "Work the goals in stale.md", source: "extension" }, f.ctx)).toEqual({ action: "handled" });
			expect(readFileSync(path, "utf8")).toBe("1. [ ] goal: retain this draft\n");
			expect(await f.hooks.get("tool_call")({ toolName: "write", input: { path: "other.txt" } }, f.ctx)).toBeUndefined();
			expect((f.entries.filter(e => e.customType === "pi-goals-state").at(-1)?.data as any).pausedFrom).toBe("planning");
			await f.commands.get("goals").handler("resume", f.ctx);
			expect(f.messages).toHaveLength(count); // returning to a draft is NOT Ready
			expect((f.entries.filter(e => e.customType === "pi-goals-state").at(-1)?.data as any).phase).toBe("planning");
		} finally { rmSync(f.cwd, { recursive: true, force: true }); }
	});

	it("stop invalidates an outstanding Ready selection", async () => {
		const f = setup([]);
		try {
			await f.commands.get("goals").handler("plan cancel selection", f.ctx);
			writeFileSync(join(f.cwd, ".pi/plan/session-a-v1.md"), "1. [ ] goal: not authorized\n");
			let answer!: (s: string) => void;
			f.ctx.ui.select = () => new Promise<string>(resolve => { answer = resolve; });
			const selecting = settleDraft(f);
			await new Promise(resolve => setImmediate(resolve));
			await f.commands.get("goals").handler("stop", f.ctx);
			answer("Ready"); await selecting;
			expect(f.messages.some(m => m.content.startsWith("Work the goals"))).toBe(false);
			expect((f.entries.filter(e => e.customType === "pi-goals-state").at(-1)?.data as any).phase).toBeNull();
		} finally { rmSync(f.cwd, { recursive: true, force: true }); }
	});

	it("resume starts unchanged authorized work but a changed plan returns to review", async () => {
		const f = setup(["Ready"]);
		try {
			await f.commands.get("goals").handler("plan bounded work", f.ctx);
			await f.commands.get("goals").handler("steward off", f.ctx);
			const path = join(f.cwd, ".pi/plan/session-a-v1.md");
			writeFileSync(path, "1. [ ] goal: first\n");
			await settleDraft(f);
			await f.commands.get("goals").handler("stop", f.ctx);
			let count = f.messages.length;
			await f.commands.get("goals").handler("resume", f.ctx);
			expect(f.messages.length).toBe(count + 1);
			await f.commands.get("goals").handler("exit", f.ctx);
			writeFileSync(path, "1. [ ] goal: changed scope\n");
			count = f.messages.length;
			await f.commands.get("goals").handler("resume", f.ctx);
			expect(f.messages).toHaveLength(count);
			expect((f.entries.filter(e => e.customType === "pi-goals-state").at(-1)?.data as any).phase).toBe("planning");
		} finally { await f.hooks.get("session_shutdown")({}, f.ctx); rmSync(f.cwd, { recursive: true, force: true }); }
	});
});

describe("/goals draft flow", () => {
	it.each(["accept", "inconclusive", "reject", "abort", "shutdown", "stop", "plan change"])("records only legitimate sign-offs on a dirty repo with ignored artifacts: %s", async (verdict) => {
		const flow = setup([]); const fresh = setup([]); const abort = new AbortController();
		try {
			execFileSync("git", ["init", "-q", flow.cwd]);
			writeFileSync(join(flow.cwd, ".gitignore"), "outputs/\n.pi/\n");
			writeFileSync(join(flow.cwd, "unrelated.txt"), "preserve this unrelated file\n");
			execFileSync("git", ["-C", flow.cwd, "add", "unrelated.txt"]); // isolated fixture only, no commit
			writeFileSync(join(flow.cwd, "unrelated.txt"), "preserve this unrelated dirty edit\n");
			mkdirSync(join(flow.cwd, "outputs"));
			writeFileSync(join(flow.cwd, "outputs/artifact.txt"), "hello\n");
			const observed = execFileSync(process.execPath, ["-e", "const fs=require('fs'); if(fs.readFileSync('outputs/artifact.txt','utf8')!=='hello\\n') process.exit(1); console.log('PASS exact bytes');"], { cwd: flow.cwd, encoding: "utf8" });
			writeFileSync(join(flow.cwd, "outputs/verify.log"), observed);
			expect(execFileSync("git", ["-C", flow.cwd, "check-ignore", "outputs/verify.log"], { encoding: "utf8" })).toContain("outputs/verify.log");
			const dirty = execFileSync("git", ["-C", flow.cwd, "status", "--porcelain"], { encoding: "utf8" });
			expect(dirty).toContain("AM unrelated.txt");
			mkdirSync(join(flow.cwd, ".pi/plan"), { recursive: true });
			const file = join(flow.cwd, ".pi/plan/session-a-v1.md");
			writeFileSync(file, "# Plan\n1. [x] goal: exact output\n  - evidence: outputs/artifact.txt `hello`; outputs/verify.log `PASS exact bytes` from node byte check\n");
			flow.entries.push({ type: "custom", customType: "pi-goals-state", data: { phase: "working", planVersion: 1, signedOffGoals: [], stewardEnabled: false, autoIntervalMs: null } });
			await flow.hooks.get("session_start")({}, flow.ctx);
			judgeRun.calls = [];
			judgeRun.output = verdict === "inconclusive" ? "No verdict from judge" : verdict === "reject" ? "VERDICT: reject\nmissing: test failed" : `checks:\n- outputs/verify.log: \`${readFileSync(join(flow.cwd, "outputs/verify.log"), "utf8").trim()}\`; execution passed\nVERDICT: accept\nmissing:`;
			judgeRun.beforeReply = () => {
				if (verdict === "abort") abort.abort();
				if (verdict === "shutdown") void flow.hooks.get("session_shutdown")({}, flow.ctx);
				if (verdict === "stop") void flow.commands.get("goals").handler("stop", flow.ctx);
				if (verdict === "plan change") writeFileSync(file, readFileSync(file, "utf8") + "\nNew scope requiring review\n");
			};
			const outcome = await flow.tools.get("CompleteGoal").execute("", { goal: " EXACT OUTPUT " }, abort.signal, undefined, flow.ctx);
			const signed = verdict === "accept" || verdict === "inconclusive";
			expect(outcome.isError).toBe(!signed);
			expect(judgeRun.calls).toHaveLength(1);
			expect(judgeRun.calls[0]).toContain("--no-extensions");
			expect(judgeRun.calls[0]).toContain("read,grep,find,ls");
			expect(readFileSync(file, "utf8").includes("[x] goal: exact output")).toBe(signed);
			if (verdict === "inconclusive") expect(outcome.content[0].text).toContain("not verified completion");
			expect(readFileSync(join(flow.cwd, "unrelated.txt"), "utf8")).toBe("preserve this unrelated dirty edit\n");
			expect(execFileSync("git", ["-C", flow.cwd, "status", "--porcelain"], { encoding: "utf8" })).toBe(dirty);
			fresh.entries.push(...structuredClone(flow.entries));
			fresh.ctx.cwd = flow.cwd; // genuinely new extension instance, same plan and persisted entries
			await fresh.hooks.get("session_start")({}, fresh.ctx);
			expect(fresh.ctx.ui.setStatus.mock.lastCall?.[1]).toContain(verdict === "stop" ? "goals stopped" : signed ? "1/1" : "0/1");
			expect(fresh.messages).toHaveLength(0);
		} finally {
			judgeRun.beforeReply = undefined; judgeRun.calls = [];
			await flow.hooks.get("session_shutdown")({}, flow.ctx); await fresh.hooks.get("session_shutdown")({}, fresh.ctx);
			rmSync(flow.cwd, { recursive: true, force: true }); rmSync(fresh.cwd, { recursive: true, force: true });
		}
	});

	it("preserves legacy completion on reload without inventing sign-off or restarting work", async () => {
		vi.useFakeTimers(); const flow = setup([]);
		try {
			mkdirSync(join(flow.cwd, ".pi/plan"), { recursive: true });
			const file = join(flow.cwd, ".pi/plan/session-a-v1.md");
			const plan = '1. [x] goal: historical result\n\n## Log\n- signed off "historical result" (judge accept)\n';
			writeFileSync(file, plan);
			flow.entries.push({ type: "custom", customType: "pi-goals-state", data: { phase: "working", planVersion: 1, stewardEnabled: false, autoIntervalMs: 1000 } });
			for (let n = 0; n < 2; n++) {
				await flow.hooks.get("session_start")({}, flow.ctx);
				await flow.hooks.get("agent_settled")({}, flow.ctx);
				await vi.advanceTimersByTimeAsync(5000);
				expect(flow.ctx.ui.setWidget.mock.lastCall?.[1]?.join("\n")).toContain("legacy completion — sign-off not recorded");
				expect(flow.messages).toHaveLength(0);
				expect(readFileSync(file, "utf8")).toBe(plan);
			}
		} finally { await flow.hooks.get("session_shutdown")({}, flow.ctx); vi.useRealTimers(); rmSync(flow.cwd, { recursive: true, force: true }); }
	});
	it("keeps unsigned manual ticks visible across reload without reopening legitimate sign-offs", async () => {
		const flow = setup([]);
		try {
			flow.entries.push({ type: "custom", customType: "pi-goals-state", data: { phase: "working", planVersion: 1, stewardEnabled: false, autoIntervalMs: null, signedOffGoals: [{ subject: "first", outcome: "accept" }, { subject: "second", outcome: "inconclusive" }] } });
			mkdirSync(join(flow.cwd, ".pi/plan"), { recursive: true });
			const file = join(flow.cwd, ".pi/plan/session-a-v1.md");
			writeFileSync(file, "# Plan\n1. [x] goal: first\n2. [x] goal: second\n3. [x] goal: manual claim\n");
			for (let i = 0; i < 2; i++) {
				await flow.hooks.get("session_start")({}, flow.ctx);
				expect(flow.ctx.ui.setStatus.mock.lastCall?.[1]).toContain("2/3");
				expect(flow.ctx.ui.setWidget.mock.lastCall?.[1]?.join("\n")).toMatch(/claimed.*manual claim/);
				expect(flow.ctx.ui.setWidget.mock.lastCall?.[1]?.join("\n")).toMatch(/inconclusive.*second/);
			}
			writeFileSync(file, readFileSync(file, "utf8").replace("[x] goal: first", "[/] goal: first"));
			await flow.hooks.get("turn_end")({}, flow.ctx);
			writeFileSync(file, readFileSync(file, "utf8").replace("[/] goal: first", "[x] goal: first"));
			await flow.hooks.get("session_start")({}, flow.ctx);
			expect(flow.ctx.ui.setStatus.mock.lastCall?.[1]).toContain("1/3");
			expect(flow.ctx.ui.setWidget.mock.lastCall?.[1]?.join("\n")).toMatch(/claimed.*first/);
		} finally { await flow.hooks.get("session_shutdown")({}, flow.ctx); rmSync(flow.cwd, { recursive: true, force: true }); }
	});

	it("retains conclusive and inconclusive sign-offs when settled detail moves below the fold", async () => {
		const flow = setup([]);
		try {
			const signoffs = [{ subject: "first", outcome: "accept" }, { subject: "second", outcome: "inconclusive" }];
			flow.entries.push({ type: "custom", customType: "pi-goals-state", data: { phase: "working", planVersion: 1, stewardEnabled: false, autoIntervalMs: null, signedOffGoals: signoffs } });
			mkdirSync(join(flow.cwd, ".pi/plan"), { recursive: true });
			const file = join(flow.cwd, ".pi/plan/session-a-v1.md");
			const goals = "# Plan\n1. [x] goal: first\n  - evidence: outputs/first.log\n2. [x] goal: second\n  - evidence: outputs/second.log\n";
			writeFileSync(file, `${goals}  - settled detail: implementation notes\n\n## Log\n`);
			await flow.hooks.get("session_start")({}, flow.ctx);
			writeFileSync(file, `${goals}\n## Log\n\n## Appendix\nSettled detail: implementation notes\n`);
			await flow.hooks.get("turn_end")({}, flow.ctx);
			await flow.hooks.get("session_start")({}, flow.ctx);
			expect(flow.ctx.ui.setStatus.mock.lastCall?.[1]).toContain("2/2");
			expect(flow.ctx.ui.setWidget.mock.lastCall?.[1]?.join("\n")).toMatch(/inconclusive.*second/);
			expect((flow.entries.at(-1)?.data as any).signedOffGoals).toEqual(signoffs);
			expect(flow.messages).toHaveLength(0);
		} finally { await flow.hooks.get("session_shutdown")({}, flow.ctx); rmSync(flow.cwd, { recursive: true, force: true }); }
	});

	it.each(["missing", "first with wording drift", "duplicate"])("requires unique goal identity before review: %s", async (goal) => {
		const flow = setup([]);
		try {
			flow.entries.push({ type: "custom", customType: "pi-goals-state", data: { phase: "working", planVersion: 1, stewardEnabled: true, autoIntervalMs: null } });
			mkdirSync(join(flow.cwd, ".pi/plan"), { recursive: true });
			const file = join(flow.cwd, ".pi/plan/session-a-v1.md");
			const plan = "1. [ ] goal: first\n2. [x] goal: duplicate\n3. [ ] goal: duplicate\n";
			writeFileSync(file, plan);
			await flow.hooks.get("session_start")({}, flow.ctx);
			const outcome = await flow.tools.get("CompleteGoal").execute("", { goal }, undefined, undefined, flow.ctx);
			expect(outcome.isError).toBe(true);
			expect(outcome.content[0].text).toMatch(/unique exact goal/i);
			expect(readFileSync(file, "utf8")).toBe(plan);
		} finally { await flow.hooks.get("session_shutdown")({}, flow.ctx); rmSync(flow.cwd, { recursive: true, force: true }); }
	});
	it("reopens a prematurely ticked submitted goal before a failed sign-off", async () => {
		const flow = setup([]);
		try {
			flow.entries.push({ type: "custom", customType: "pi-goals-state", data: { phase: "working", planVersion: 1, stewardEnabled: true, autoIntervalMs: null } });
			await flow.hooks.get("session_start")({}, flow.ctx);
			const file = join(flow.cwd, ".pi/plan/session-a-v1.md");
			mkdirSync(join(flow.cwd, ".pi/plan"), { recursive: true });
			writeFileSync(file, "# Plan\n1. [x] goal: first\n  - [x] subtask\n2. [ ] goal: second\n");
			const outcome = await flow.tools.get("CompleteGoal").execute("", { goal: "first" }, undefined, undefined, flow.ctx);
			expect(outcome.isError).toBe(true);
			expect(readFileSync(file, "utf8")).toBe("# Plan\n1. [/] goal: first\n  - [x] subtask\n2. [ ] goal: second\n");
		} finally { await flow.hooks.get("session_shutdown")({}, flow.ctx); rmSync(flow.cwd, { recursive: true, force: true }); }
	});
	it("enables steward and hourly auto by default in new and cleared legacy sessions", async () => {
		for (const legacy of [false, true]) {
			const flow = setup([]);
			try {
				if (legacy) flow.entries.push({ type: "custom", customType: "pi-goals-state", data: { phase: null, planVersion: null, stewardEnabled: false, autoIntervalMs: null } });
				await flow.hooks.get("session_start")({}, flow.ctx);
				await flow.commands.get("goals").handler("objective", flow.ctx);
				expect(flow.entries.at(-1)?.data).toMatchObject({ defaultsVersion: 1, stewardEnabled: true, autoIntervalMs: 3_600_000 });
				await flow.commands.get("goals").handler("clear", flow.ctx);
				expect(flow.entries.at(-1)?.data).toMatchObject({ phase: null, stewardEnabled: true, autoIntervalMs: 3_600_000 });
			} finally { await flow.hooks.get("session_shutdown")({}, flow.ctx); rmSync(flow.cwd, { recursive: true, force: true }); }
		}
	});

	it("preserves explicit off preferences across reload and a new plan", async () => {
		const flow = setup([]);
		try {
			await flow.hooks.get("session_start")({}, flow.ctx);
			await flow.commands.get("goals").handler("steward off", flow.ctx);
			await flow.commands.get("goals").handler("auto off", flow.ctx);
			await flow.hooks.get("session_start")({}, flow.ctx);
			await flow.commands.get("goals").handler("objective", flow.ctx);
			expect(flow.entries.at(-1)?.data).toMatchObject({ defaultsVersion: 1, stewardEnabled: false, autoIntervalMs: null });
		} finally { await flow.hooks.get("session_shutdown")({}, flow.ctx); rmSync(flow.cwd, { recursive: true, force: true }); }
	});

	it("does not enable automation midway through a legacy working plan", async () => {
		const flow = setup([]);
		try {
			flow.entries.push({ type: "custom", customType: "pi-goals-state", data: { phase: "working", planVersion: 1, stewardEnabled: false, autoIntervalMs: null } });
			await flow.hooks.get("session_start")({}, flow.ctx);
			await flow.commands.get("goals").handler("judge", flow.ctx);
			expect(flow.entries.at(-1)?.data).toMatchObject({ phase: "working", stewardEnabled: false, autoIntervalMs: null });
		} finally { await flow.hooks.get("session_shutdown")({}, flow.ctx); rmSync(flow.cwd, { recursive: true, force: true }); }
	});

	it("uses the plan escape for objectives beginning with reserved command words", async () => {
		const flow = setup([]);
		try {
			for (const objective of ["judge the vendor options", "auto generate captions", "steward the migration", "clear"]) {
				await flow.commands.get("goals").handler(`plan ${objective}`, flow.ctx);
				expect(flow.messages.at(-1)?.content).toContain(`Objective: ${objective}`);
			}
			expect(flow.entries.at(-1)?.data).toMatchObject({ phase: "planning", planVersion: 4, judgeModel: null });
		} finally { rmSync(flow.cwd, { recursive: true, force: true }); }
	});

	it("keeps an enabled plan in planning when a real supervisor cannot be launched", async () => {
		const flow = setup(["Ready"]);
		vi.stubEnv("HERDR_ENV", "");
		try {
			await flow.hooks.get("session_start")({}, flow.ctx);
			await flow.commands.get("goals").handler("objective", flow.ctx);
			writeFileSync(join(flow.cwd, ".pi/plan/session-a-v1.md"), "# Plan\n\n1. [ ] goal: make the file\n");
			await settleDraft(flow);
			expect(flow.entries.at(-1)?.data).toMatchObject({ phase: "planning", stewardEnabled: true });
			expect(flow.messages.some(message => message.content.startsWith("Work the goals"))).toBe(false);
		} finally { vi.unstubAllEnvs(); rmSync(flow.cwd, { recursive: true, force: true }); }
	});

	it("preserves prior drafts, displays the plan before Discuss, and records chat answers", async () => {
		const flow = setup(["Discuss"]);
		try {
			const legacy = join(flow.cwd, ".pi/plan/session-a.md");
			mkdirSync(join(flow.cwd, ".pi/plan"), { recursive: true });
			writeFileSync(legacy, "old plan");
			await flow.commands.get("goals").handler("first objective", flow.ctx);
			const v1 = join(flow.cwd, ".pi/plan/session-a-v1.md");
			expect(readFileSync(v1, "utf-8")).toBe("");
			expect(readFileSync(legacy, "utf-8")).toBe("old plan");
			const plan = "# First plan\n\n## Goals\n\n1. [ ] goal: preserve this\n\n## Appendix (context, not approved)\nold context\n";
			mkdirSync(join(flow.cwd, ".pi/plan"), { recursive: true });
			writeFileSync(v1, plan);
			await flow.hooks.get("input")({ text: "The result must preserve column order.", source: "interactive" }, flow.ctx);

			await settleDraft(flow);
			expect(flow.events).toEqual(["display", "select"]);
			expect(flow.messages.at(-1)?.content).toContain("normal chat");
			await flow.hooks.get("input")({ text: "Keep two columns.\nDo not add a filter.", source: "interactive" }, flow.ctx);
			expect(flow.messages.find((message) => message.display)?.content).toContain("goal: preserve this");
			const interviewedPlan = readFileSync(v1, "utf-8");
			expect(interviewedPlan).toContain("> The result must preserve column order.");
			expect(interviewedPlan).toMatch(/## Interview\n\n### .+\n\n> The result must preserve column order\.[\s\S]+> Keep two columns\.\n> Do not add a filter\./);
			const refineSnapshot = await flow.hooks.get("before_agent_start")({}, flow.ctx);
			expect(refineSnapshot.message.content).toContain("[PLANNING MODE]");
			const blocked = await flow.hooks.get("tool_call")({ toolName: "edit", input: { path: "README.md" } }, flow.ctx);
			expect(blocked?.block).toBe(true);

			await flow.commands.get("goals").handler("second objective", flow.ctx);
			expect(readFileSync(v1, "utf-8")).toBe(interviewedPlan);
			expect(readFileSync(join(flow.cwd, ".pi/plan/session-a-v2.md"), "utf-8")).toBe("");
			expect(flow.messages.at(-1)?.content).toContain("session-a-v2.md");

			await flow.commands.get("goals").handler("compare the vendor options", flow.ctx);
			expect(readFileSync(join(flow.cwd, ".pi/plan/session-a-v3.md"), "utf-8")).toBe("");
			expect(flow.messages.at(-1)?.content).toContain("Objective: compare the vendor options");

			await flow.commands.get("goals").handler("judge provider/model", flow.ctx);
			expect(flow.entries.at(-1)?.data).toMatchObject({ judgeModel: "provider/model", planVersion: 3 });
		} finally {
			rmSync(flow.cwd, { recursive: true, force: true });
		}
	});

	it("disconnects without deleting the active plan", async () => {
		const flow = setup([]);
		try {
			await flow.commands.get("goals").handler("objective", flow.ctx);
			const planPath = join(flow.cwd, ".pi/plan/session-a-v1.md");
			writeFileSync(planPath, "# Plan\n\n## Goals\n\n1. [ ] goal: preserve this\n");

			await flow.commands.get("goals").handler("clear", flow.ctx);

			expect(readFileSync(planPath, "utf-8")).toContain("goal: preserve this");
			expect(flow.entries.at(-1)?.data).toMatchObject({ phase: null, planVersion: null });

			await flow.commands.get("goals").handler("next objective", flow.ctx);
			expect(readFileSync(join(flow.cwd, ".pi/plan/session-a-v2.md"), "utf-8")).toBe("");
		} finally {
			rmSync(flow.cwd, { recursive: true, force: true });
		}
	});

	it("Discuss allows multiple chat turns, survives reload, and reopens review for an unchanged draft", async () => {
		const flow = setup(["Discuss", "Ready"]);
		try {
			await flow.commands.get("goals").handler("steward off", flow.ctx);
			await flow.commands.get("goals").handler("objective", flow.ctx);
			const path = join(flow.cwd, ".pi/plan/session-a-v1.md");
			writeFileSync(path, "# Plan\n\n1. [ ] goal: make this specific\n");
			await settleDraft(flow);
			expect(flow.events).toEqual(["display", "select"]);
			expect(flow.entries.at(-1)?.data).toMatchObject({ phase: "planning", reviewRequested: false });
			await flow.hooks.get("agent_settled")({}, flow.ctx); // question turn, not another menu
			await flow.hooks.get("input")({ text: "Only the existing output; no new UI.", source: "interactive" }, flow.ctx);
			await flow.hooks.get("agent_settled")({}, flow.ctx);
			await flow.hooks.get("session_start")({ reason: "reload" }, flow.ctx);
			await flow.hooks.get("agent_settled")({}, flow.ctx);
			expect(flow.events).toEqual(["display", "select"]);
			const unchanged = readFileSync(path, "utf8");
			await settleDraft(flow);
			expect(readFileSync(path, "utf8")).toBe(unchanged);
			await flow.hooks.get("agent_settled")({}, flow.ctx);
			expect(flow.events).toEqual(["display", "select", "display", "select"]);
			expect(flow.messages.filter(m => m.content.startsWith("Work the goals"))).toHaveLength(1);
		} finally { await flow.hooks.get("session_shutdown")({}, flow.ctx); rmSync(flow.cwd, { recursive: true, force: true }); }
	});

	it("starts work only when the human chooses Ready", async () => {
		const flow = setup(["Ready"]);
		try {
			await flow.commands.get("goals").handler("steward off", flow.ctx);
			await flow.commands.get("goals").handler("objective", flow.ctx);
			const planPath = join(flow.cwd, ".pi/plan/session-a-v1.md");
			writeFileSync(planPath, "# Plan\n\n## Goals\n\n1. [ ] goal: work on this\n");

			await settleDraft(flow);

			expect(flow.events).toEqual(["display", "select"]);
			expect(flow.messages.filter((message) => !message.display)).toHaveLength(2);
			expect(flow.messages.at(-1)?.content).toContain("Work the goals");
			await flow.hooks.get("session_start")({}, flow.ctx);
			expect((await promptReminder(flow)).content).toContain("New session.");
			expect(await promptReminder(flow)).toBeUndefined();
		} finally {
			rmSync(flow.cwd, { recursive: true, force: true });
		}
	});

	it("refuses to enable a steward after an unreviewed plan is already working", async () => {
		const flow = setup(["Ready"]);
		try {
			await flow.hooks.get("session_start")({}, flow.ctx);
			await flow.commands.get("goals").handler("steward off", flow.ctx);
			await flow.commands.get("goals").handler("objective", flow.ctx);
			const planPath = join(flow.cwd, ".pi/plan/session-a-v1.md");
			writeFileSync(planPath, "# Plan\n\n## Goals\n\n1. [ ] goal: make the file\n");
			await settleDraft(flow);
			await flow.commands.get("goals").handler("steward on", flow.ctx);
			expect(flow.entries.at(-1)?.data).toMatchObject({ phase: "working", stewardEnabled: false, supervisor: null });
		} finally {
			rmSync(flow.cwd, { recursive: true, force: true });
		}
	});

	it("edits a plan in Pi and cancels without starting work", async () => {
		const original = "# Plan\n\n## Goals\n\n1. [ ] goal: original\n";
		const edited = "# Plan\n\n## Goals\n\n1. [ ] goal: edited\n";
		const flow = setup(["Edit", "Cancel"], [edited]);
		try {
			await flow.commands.get("goals").handler("objective", flow.ctx);
			const planPath = join(flow.cwd, ".pi/plan/session-a-v1.md");
			writeFileSync(planPath, original);

			await settleDraft(flow);

			expect(flow.events).toEqual(["display", "select", "editor", "display", "select"]);
			expect(() => readFileSync(planPath, "utf-8")).toThrow();
			expect(flow.messages.filter((message) => !message.display)).toHaveLength(1);
		} finally {
			rmSync(flow.cwd, { recursive: true, force: true });
		}
	});

	it("reminds every eight unchanged working-set turns, ignoring log-only edits", async () => {
		const flow = setup(["Ready"]);
		try {
			await flow.commands.get("goals").handler("steward off", flow.ctx);
			await flow.commands.get("goals").handler("objective", flow.ctx);
			const planPath = join(flow.cwd, ".pi/plan/session-a-v1.md");
			writeFileSync(planPath, "# Plan\n\n## Goals\n\n1. [/] goal: make the output\n\n## Log\n");
			await settleDraft(flow);

			await flow.hooks.get("turn_end")({}, flow.ctx);
			for (let turn = 0; turn < 3; turn++) await flow.hooks.get("turn_end")({}, flow.ctx);
			writeFileSync(planPath, "# Plan\n\n## Goals\n\n1. [/] goal: make the output\n\n## Log\n- checked input\n");
			for (let turn = 0; turn < 5; turn++) await flow.hooks.get("turn_end")({}, flow.ctx);

			expect((await flow.hooks.get("context")({ messages: [] }, flow.ctx)).messages).toHaveLength(0);
			const reminder = await promptReminder(flow);
			expect(reminder.content).toContain(".pi/plan/session-a-v1.md");
			expect(reminder.content).not.toContain("checked input");
			expect(await promptReminder(flow)).toBeUndefined();

			writeFileSync(planPath, "# Plan\n\n## Goals\n\n1. [/] goal: make the output\n  - [x] inspect input\n\n## Log\n- checked input\n");
			await flow.hooks.get("turn_end")({}, flow.ctx);
			for (let turn = 0; turn < 7; turn++) await flow.hooks.get("turn_end")({}, flow.ctx);
			expect(await promptReminder(flow)).toBeUndefined();
			await flow.hooks.get("turn_end")({}, flow.ctx);
			expect((await promptReminder(flow)).content).toContain("make the output");
		} finally {
			rmSync(flow.cwd, { recursive: true, force: true });
		}
	});

	it("does not acknowledge an unpersisted reminder; retries fresh on the next natural prompt", async () => {
		const flow = setup([]);
		try {
			flow.entries.push({ type: "custom", customType: "pi-goals-state", data: { phase: "working", planVersion: 1, stewardEnabled: false, autoIntervalMs: null } });
			const planPath = join(flow.cwd, ".pi/plan/session-a-v1.md");
			mkdirSync(join(flow.cwd, ".pi/plan"), { recursive: true });
			writeFileSync(planPath, "1. [ ] goal: old plan\n");
			await flow.hooks.get("session_start")({}, flow.ctx);
			await flow.hooks.get("session_compact")({}, flow.ctx);
			const unsaved = await flow.hooks.get("before_agent_start")({}, flow.ctx);
			expect(unsaved.message.content).toContain("old plan");
			expect((await flow.hooks.get("context")({ messages: [] }, flow.ctx)).messages).toEqual([]);
			writeFileSync(planPath, "1. [ ] goal: fresh plan\n");
			const saved = await promptReminder(flow);
			expect(saved.content).toContain("The session was just compacted.");
			expect(saved.content).toContain("fresh plan");
			expect(saved.details.reminderId).not.toBe(unsaved.message.details.reminderId);
			expect(await promptReminder(flow)).toBeUndefined();
			expect(flow.messages).toEqual([]); // no queued sendMessage/sendUserMessage delivery
		} finally { await flow.hooks.get("session_shutdown")({}, flow.ctx); rmSync(flow.cwd, { recursive: true, force: true }); }
	});

	it("auto-continues once on stop, then pauses after two no-progress wakes", async () => {
		vi.useFakeTimers();
		const flow = setup(["Ready"]);
		try {
			await flow.commands.get("goals").handler("steward off", flow.ctx);
			await flow.commands.get("goals").handler("objective", flow.ctx);
			const planPath = join(flow.cwd, ".pi/plan/session-a-v1.md");
			writeFileSync(planPath, "# Plan\n\n## Goals\n\n1. [/] goal: make the output\n");
			await settleDraft(flow);
			await flow.commands.get("goals").handler("auto 1", flow.ctx);

			await settleDraft(flow);
			await vi.advanceTimersByTimeAsync(0);
			const autoMessages = () => flow.messages.filter((message) => message.content.includes("Auto-continue is enabled"));
			expect(autoMessages()).toHaveLength(1);

			await settleDraft(flow);
			await vi.advanceTimersByTimeAsync(60_000);
			expect(autoMessages()).toHaveLength(2);
			await settleDraft(flow);
			await vi.advanceTimersByTimeAsync(60_000);
			expect(autoMessages()).toHaveLength(2);
		} finally {
			vi.useRealTimers();
			rmSync(flow.cwd, { recursive: true, force: true });
		}
	});

	it("delays auto-continuation after a known background start", async () => {
		vi.useFakeTimers();
		const flow = setup(["Ready"]);
		try {
			await flow.commands.get("goals").handler("steward off", flow.ctx);
			await flow.commands.get("goals").handler("objective", flow.ctx);
			const planPath = join(flow.cwd, ".pi/plan/session-a-v1.md");
			writeFileSync(planPath, "# Plan\n\n## Goals\n\n1. [/] goal: make the output\n");
			await settleDraft(flow);
			await flow.commands.get("goals").handler("auto 1", flow.ctx);
			await flow.hooks.get("agent_start")({}, flow.ctx);
			await flow.hooks.get("tool_call")({ toolName: "process", input: { action: "start" } }, flow.ctx);
			await settleDraft(flow);
			await vi.advanceTimersByTimeAsync(0);
			const autoMessages = () => flow.messages.filter((message) => message.content.includes("Auto-continue is enabled"));
			expect(autoMessages()).toHaveLength(0);
			await vi.advanceTimersByTimeAsync(60_000);
			expect(autoMessages()).toHaveLength(1);
		} finally {
			vi.useRealTimers();
			rmSync(flow.cwd, { recursive: true, force: true });
		}
	});

	it("gives the agent a planning snapshot and blocks work routes", async () => {
		const flow = setup([]);
		try {
			await flow.commands.get("goals").handler("objective", flow.ctx);
			const planPath = join(flow.cwd, ".pi/plan/session-a-v1.md");
			expect(flow.entries.at(-1)?.data).toMatchObject({ phase: "planning" });
			await flow.hooks.get("session_start")({}, flow.ctx);
			const snapshot = await flow.hooks.get("before_agent_start")({}, flow.ctx);
			expect(snapshot.message.content).toContain("[PLANNING MODE]");
			expect(snapshot.message.content).toContain(planPath);

			const writePlan = await flow.hooks.get("tool_call")({ toolName: "write", input: { path: planPath } }, flow.ctx);
			const writeCode = await flow.hooks.get("tool_call")({ toolName: "write", input: { path: "README.md" } }, flow.ctx);
			const readShell = await flow.hooks.get("tool_call")({ toolName: "bash", input: { command: "pwd && ls && git log" } }, flow.ctx);
			const changeDirectoryThenRead = await flow.hooks.get("tool_call")({ toolName: "bash", input: { command: "cd . && ls -la" } }, flow.ctx);
			const pipeShell = await flow.hooks.get("tool_call")({ toolName: "bash", input: { command: "ls | head" } }, flow.ctx);
			const pythonWrite = await flow.hooks.get("tool_call")({ toolName: "bash", input: { command: "python -c \"open('README.md', 'w')\"" } }, flow.ctx);
			const signoff = await flow.tools.get("CompleteGoal").execute("", { goal: "work" }, undefined, undefined, flow.ctx);
			await flow.hooks.get("session_compact")({}, flow.ctx);
			expect(await flow.hooks.get("context")({ messages: [] }, flow.ctx)).toBeUndefined();
			const compacted = await promptReminder(flow);

			expect(writePlan).toBeUndefined();
			expect(writeCode?.block).toBe(true);
			expect(readShell).toBeUndefined();
			expect(changeDirectoryThenRead).toBeUndefined();
			expect(pipeShell?.block).toBe(true);
			expect(pythonWrite?.block).toBe(true);
			expect(signoff.isError).toBe(true);
			expect(compacted.content).toContain("[PLANNING MODE]");
			expect(await promptReminder(flow)).toBeUndefined();
		} finally {
			rmSync(flow.cwd, { recursive: true, force: true });
		}
	});
});

describe("role models across goal lifecycle", () => {
	const choice = (role: string) => ({ provider: `${role}-provider`, id: `${role}-model` });
	const select = async (flow: ReturnType<typeof setup>, role: string) => {
		flow.ctx.model = choice(role);
		await flow.hooks.get("model_select")({ source: "cycle", model: flow.ctx.model }, flow.ctx);
	};
	const draft = (flow: ReturnType<typeof setup>, version = 1) => writeFileSync(join(flow.cwd, `.pi/plan/session-a-v${version}.md`), "# Plan\n\n1. [ ] goal: produce the artifact\n");
	it("restores each role at Ready, fresh-instance reload/resume and the next plan without changing judge override", async () => {
		const flow = setup(["Ready"]); const fresh = setup([]);
		try {
			await flow.commands.get("goals").handler("steward off", flow.ctx);
			await flow.commands.get("goals").handler("first", flow.ctx); await select(flow, "planning"); draft(flow);
			await settleDraft(flow); await select(flow, "worker");
			await flow.commands.get("goals").handler("judge isolated/judge", flow.ctx);
			fresh.entries.push(...structuredClone(flow.entries));
			await fresh.hooks.get("session_start")({ reason: "resume" }, fresh.ctx);
			expect(fresh.ctx.model).toEqual(choice("worker"));
			await fresh.commands.get("goals").handler("second", fresh.ctx);
			expect(fresh.ctx.model).toEqual(choice("planning"));
			expect(fresh.entries.at(-1)?.data).toMatchObject({ phase: "planning", judgeModel: "isolated/judge" });
			await fresh.hooks.get("session_start")({ reason: "reload" }, fresh.ctx);
			expect(fresh.ctx.model).toEqual(choice("planning"));
		} finally { for (const f of [flow, fresh]) { await f.hooks.get("session_shutdown")({}, f.ctx); rmSync(f.cwd, { recursive: true, force: true }); } }
	});

	it("failed Ready and explicit cancellation never save a worker choice over planning", async () => {
		const flow = setup(["Ready", "Cancel"]); vi.stubEnv("HERDR_ENV", "");
		try {
			await flow.commands.get("goals").handler("objective", flow.ctx); await select(flow, "planning"); draft(flow);
			await settleDraft(flow); expect(flow.ctx.model).toEqual(choice("planning"));
			expect(flow.messages.some(m => m.content.startsWith("Work the goals"))).toBe(false);
			await settleDraft(flow);
			await select(flow, "outside-plan");
			await flow.commands.get("goals").handler("next plan", flow.ctx);
			expect(flow.ctx.model).toEqual(choice("planning"));
		} finally { await flow.hooks.get("session_shutdown")({}, flow.ctx); rmSync(flow.cwd, { recursive: true, force: true }); }
	});

	it("unavailable worker model blocks Ready until an explicit selection, without changing its remembered provider", async () => {
		const flow = setup(["Ready", "Ready"]);
		const dir = join(process.env.PI_CODING_AGENT_DIR!, "pi-goals"); mkdirSync(dir);
		writeFileSync(join(dir, "worker-model.json"), JSON.stringify(choice("worker")));
		try {
			await flow.commands.get("goals").handler("steward off", flow.ctx);
			await flow.commands.get("goals").handler("objective", flow.ctx); draft(flow);
			flow.pi.setModel.mockResolvedValueOnce(false);
			await settleDraft(flow);
			expect(flow.entries.at(-1)?.data).toMatchObject({ phase: "planning" });
			expect(flow.messages.some(m => m.content.startsWith("Work the goals"))).toBe(false);
			expect(flow.ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("has no authentication"), "error");
			expect(JSON.parse(readFileSync(join(dir, "worker-model.json"), "utf8"))).toEqual(choice("worker"));
			await select(flow, "replacement-worker"); await settleDraft(flow);
			expect(flow.ctx.model).toEqual(choice("replacement-worker"));
			expect(flow.messages.filter(m => m.content.startsWith("Work the goals"))).toHaveLength(1);
		} finally { await flow.hooks.get("session_shutdown")({}, flow.ctx); rmSync(flow.cwd, { recursive: true, force: true }); }
	});

	it("supervisor resume uses its own preference and never restores inherited worker automation/tools", async () => {
		const flow = setup([]);
		const dir = join(process.env.PI_CODING_AGENT_DIR!, "pi-goals"); mkdirSync(dir);
		writeFileSync(join(dir, "supervisor-model.json"), JSON.stringify(choice("supervisor")));
		try {
			flow.entries.push({ type: "custom", customType: "pi-goals-state", data: { phase: "working", planVersion: 1, autoIntervalMs: 1, stewardEnabled: false } });
			flow.entries.push({ type: "custom", customType: "pi-goals-supervisor", data: { binding: { id: "binding" }, workerId: "worker" } });
			await flow.hooks.get("session_start")({ reason: "resume" }, flow.ctx);
			expect(flow.ctx.model).toEqual(choice("supervisor"));
			expect(flow.pi.getActiveTools()).not.toContain("CompleteGoal");
			expect(flow.pi.getActiveTools()).not.toContain("RequestPlanReview");
			await flow.hooks.get("agent_settled")({}, flow.ctx);
			expect(flow.messages).toEqual([]);
		} finally { await flow.hooks.get("session_shutdown")({}, flow.ctx); rmSync(flow.cwd, { recursive: true, force: true }); }
	});

	it("waives alignment only for the current plan and Escape returns to chat without deleting the draft", async () => {
		const flow = setup([undefined]);
		try {
			await flow.commands.get("goals").handler("first; no questions", flow.ctx);
			expect(flow.entries.at(-1)?.data).toMatchObject({ questionsWaived: true });
			expect(flow.messages.at(-1)?.content).toContain("THIS plan only");
			await flow.commands.get("goals").handler("second", flow.ctx);
			expect(flow.entries.at(-1)?.data).toMatchObject({ questionsWaived: false, reviewRequested: false });
			expect(flow.messages.at(-1)?.content).toContain("previous plan does NOT apply");
			draft(flow, 2);
			await flow.hooks.get("agent_settled")({}, flow.ctx); expect(flow.events).toEqual([]);
			await settleDraft(flow);
			expect(flow.entries.at(-1)?.data).toMatchObject({ phase: "planning", reviewRequested: false });
			expect(readFileSync(join(flow.cwd, ".pi/plan/session-a-v2.md"), "utf8")).toContain("produce the artifact");
			expect(flow.events).toEqual(["display", "select"]);
		} finally { await flow.hooks.get("session_shutdown")({}, flow.ctx); rmSync(flow.cwd, { recursive: true, force: true }); }
	});
});

it("cancels an ordinary Ready handoff suspended in setModel without losing planning preference", async () => {
	const flow = setup(["Ready"]);
	try {
		await flow.commands.get("goals").handler("steward off", flow.ctx);
		await flow.commands.get("goals").handler("objective", flow.ctx);
		writeFileSync(join(flow.cwd, ".pi/plan/session-a-v1.md"), "# Plan\n\n1. [ ] goal: produce output\n");
		const dir = join(process.env.PI_CODING_AGENT_DIR!, "pi-goals");
		writeFileSync(join(dir, "worker-model.json"), JSON.stringify({ provider: "worker", id: "work" }));
		let finish!: () => void;
		flow.pi.setModel.mockImplementationOnce(async model => { await new Promise<void>(resolve => { finish = resolve; }); flow.ctx.model = model; return true; });
		const starting = settleDraft(flow);
		await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
		await flow.commands.get("goals").handler("clear", flow.ctx);
		finish(); await starting;
		expect(flow.ctx.model).toEqual({ provider: "offline", id: "test" });
		expect(flow.messages.some(m => m.content.startsWith("Work the goals"))).toBe(false);
		expect(JSON.parse(readFileSync(join(dir, "worker-model.json"), "utf8"))).toEqual({ provider: "worker", id: "work" });
	} finally { await flow.hooks.get("session_shutdown")({}, flow.ctx); rmSync(flow.cwd, { recursive: true, force: true }); }
});
