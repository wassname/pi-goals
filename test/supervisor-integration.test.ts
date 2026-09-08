import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import goals from "../src/index.js";
import { SUPERVISOR_ROLE } from "../src/supervisor.js";

const judge = vi.hoisted(() => ({ calls: [] as string[][] }));
vi.mock("node:child_process", async (original) => {
	const actual = await original<typeof import("node:child_process")>();
	return { ...actual, spawn: (_command: string, args: string[]) => {
		judge.calls.push(args);
		const process = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter(), kill() {} });
		queueMicrotask(() => { process.stdout.emit("data", "## checks:\n- evidence.txt: `PASS`; the saved check passed\n\nVERDICT: accept\nmissing:"); process.emit("close", 0); });
		return process;
	} };
});

const tick = () => new Promise(resolve => setImmediate(resolve));
afterEach(() => { vi.unstubAllEnvs(); judge.calls = []; });

describe("actual goals and supervisor package hooks (Herdr and judge mocked)", () => {
	it.each(["completion", "replacement during activation", "steward off during activation", "missing worker model", "unauthenticated worker model", "clear while model unavailable", "off while model unavailable", "clear during recovery restore", "replacement during recovery restore"])("Ready forks once and preserves lifecycle ownership: %s", async (scenario) => {
		const cwd = mkdtempSync(join(tmpdir(), "goals-supervisor-integration-"));
		const peers: any[] = [];
		const wires: any[] = [];
		const herdrCalls: string[][] = [];
		const modelDir = join(process.env.PI_CODING_AGENT_DIR!, "pi-goals"); mkdirSync(modelDir);
		for (const role of ["worker", "supervisor"]) writeFileSync(join(modelDir, `${role}-model.json`), JSON.stringify({ provider: "offline", id: role }));
		vi.stubEnv("HERDR_ENV", "1"); vi.stubEnv("HERDR_PANE_ID", "w1:p1");
		function make(id: string, manager: SessionManager) {
			const hooks = new Map<string, any[]>(); const commands = new Map<string, any>(); const tools = new Map<string, any>(); const listeners = new Map<string, Set<any>>();
			const messages: string[] = []; const contexts: any[] = []; let active = ["read", "grep", "bash", "write", "edit"];
			const peer: any = { id, manager, messages, contexts, commands, tools, compactions: 0, compactionModels: [], modelChanges: [], aborts: 0 };
			const bus = {
				on(name: string, fn: any) { const list = listeners.get(name) ?? new Set(); list.add(fn); listeners.set(name, list); return () => list.delete(fn); },
				emit(name: string, payload: any) {
					if (name === "intercom:extension-register") {
						peer.receive = payload.onEvent;
						payload.onReady({ snapshot: () => ({ connected: true, supported: true }), listSessions: async () => peers.map(p => ({ id: p.id, pid: p === peer ? process.pid : process.pid + 1, cwd, model: "offline/test" })), publish(wire: any) { if (wire.t === "plan_activate") expect(peer.ctx.model.id).not.toBe("planning"); wires.push(wire); for (const p of peers) queueMicrotask(() => p.receive({ type: "message", fromSessionId: peer.id, payload: wire })); } });
						return true;
					}
					if (name === "processes:request:list") payload.reply([]);
					if (name === "subagents:rpc:v1:request") {
						const reply = () => bus.emit(`subagents:rpc:v1:reply:${payload.requestId}`, { requestId: payload.requestId, success: true, data: { fleet: { version: 1, totalActive: 0 } } });
						if (peer.delayBackground) { peer.finishBackground = reply; return; }
						reply();
					}
					for (const fn of listeners.get(name) ?? []) fn(payload);
				},
			};
			const pi: any = {
				setModel: async (model: any) => {
					if (peer.noAuth && model.id === "worker") return false;
					if (peer.deferWorkerRestore && model.id === "worker") {
						peer.deferWorkerRestore = false;
						await new Promise<void>(resolve => { peer.finishRestore = resolve; });
					}
					const previousModel = ctx.model; ctx.model = model; peer.modelChanges.push(model.id);
					manager.appendModelChange(model.provider, model.id);
					await peer.hook("model_select", { source: "set", model, previousModel }); return true;
				},
				events: bus, on(name: string, fn: any) { hooks.set(name, [...(hooks.get(name) ?? []), fn]); },
				registerCommand(name: string, command: any) { commands.set(name, command); }, registerTool(tool: any) { tools.set(tool.name, tool); active.push(tool.name); },
				appendEntry: (name: string, data: any) => manager.appendCustomEntry(name, data),
				getActiveTools: () => active, setActiveTools: (names: string[]) => { active = names; },
				getCommands: () => [{ name: "supervise", sourceInfo: { path: "internal-supervisor" } }],
				getAllTools: () => [{ name: "subagent" }, { name: "intercom", sourceInfo: { path: "intercom-test-only" } }],
				sendUserMessage: (text: string) => messages.push(text), sendMessage: (message: any) => contexts.push(message),
				exec: async (command: string, args: string[]) => {
					expect(command).toBe("herdr"); herdrCalls.push(args);
					if (args[0] === "pane") return { code: 0, stdout: JSON.stringify({ result: { pane: { pane_id: "w1:p2" } } }), stderr: "" };
					if (args[1] === "start") {
						const sessionFile = args[args.indexOf("--session") + 1];
						const supervisor = make("supervisor", SessionManager.open(sessionFile));
						await supervisor.hook("session_start"); await tick();
					}
					return { code: 0, stdout: "{}", stderr: "" };
				},
			};
			const ctx: any = { cwd, hasUI: true, isIdle: () => true, model: { provider: "offline", id: (manager.getBranch().findLast((entry: any) => entry.type === "model_change") as any)?.modelId ?? "test", contextWindow: 200_000 }, sessionManager: manager,
				modelRegistry: { find: (provider: string, id: string) => peer.missing && id === "worker" ? undefined : ({ provider, id, contextWindow: 200_000 }) },
				getContextUsage: () => ({ tokens: 50_000 }), compact({ onComplete }: any) { peer.compactions++; peer.compactionModels.push(ctx.model.id); onComplete({}); }, abort() { peer.aborts++; },
				ui: { theme: { fg: (_: string, text: string) => text }, setWidget() {}, setStatus() {}, notify: vi.fn(), select: async () => "Ready" },
			};
			peer.pi = pi; peer.ctx = ctx; peer.hook = async (name: string, event = {}) => { for (const fn of hooks.get(name) ?? []) await fn(event, ctx); };
			peers.push(peer); goals(pi); return peer;
		}
		const manager = SessionManager.create(cwd, join(cwd, "sessions"));
		manager.appendMessage({ role: "user", content: "Keep the literal [x] and produce two files", timestamp: Date.now() });
		manager.appendMessage({ role: "assistant", content: [{ type: "text", text: "Plan drafted" }], api: "openai-completions", provider: "offline", model: "test", stopReason: "stop", timestamp: Date.now(), usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
		const worker = make("worker", manager);
		try {
			await worker.hook("session_start");
			await worker.commands.get("goals").handler("plan judge the vendor options", worker.ctx);
			worker.ctx.model = { provider: "offline", id: "planning", contextWindow: 200_000 };
			manager.appendModelChange("offline", "planning");
			await worker.hook("model_select", { source: "cycle", model: worker.ctx.model });
			const path = join(cwd, ".pi", "plan", `${manager.getSessionId()}-v1.md`);
			writeFileSync(path, '# Plan\n\nUser voice: render "[x]" literally\n\n1. [ ] goal: first\n2. [ ] goal: second\n\n## Log\n');
			worker.delayBackground = scenario.includes("during activation");
			worker.missing = scenario === "missing worker model" || scenario.includes("during recovery restore");
			worker.noAuth = scenario === "unauthenticated worker model";
			await worker.tools.get("RequestPlanReview").execute("", {}, undefined, undefined, worker.ctx);
			const starting = worker.hook("agent_settled");
			if (worker.delayBackground) {
				await vi.waitFor(() => expect(worker.finishBackground).toBeTypeOf("function"));
				expect(worker.messages.filter((m: string) => m.startsWith("Work the goals"))).toHaveLength(0);
				const stopping = scenario === "steward off during activation";
				await worker.commands.get("goals").handler(stopping ? "steward off" : "plan a replacement that has not received Ready", worker.ctx);
				worker.finishBackground(); await starting; await tick();
				expect(worker.messages.filter((m: string) => m.startsWith("Work the goals"))).toHaveLength(0);
				expect(worker.ctx.model.id).toBe("planning");
				expect(worker.modelChanges).toContain("worker");
				const saved = manager.getBranch().findLast((entry: any) => entry.customType === "pi-goals-state") as any;
				expect(saved.data).toMatchObject({ phase: "planning", planVersion: stopping ? 1 : 2, supervisor: null });
				if (stopping) {
					expect(saved.data.stewardEnabled).toBe(false);
					worker.delayBackground = false;
					await worker.hook("agent_settled"); // Ready is offered again; ordinary work can now start.
					expect(worker.messages.filter((m: string) => m.startsWith("Work the goals"))).toHaveLength(1);
					const retried = manager.getBranch().findLast((entry: any) => entry.customType === "pi-goals-state") as any;
					expect(retried.data).toMatchObject({ phase: "working", planVersion: 1 });
				}
				expect(herdrCalls.filter(args => args[1] === "start")).toHaveLength(1);
				return;
			}
			await starting; await tick();
			const supervisor = peers[1];
			if (worker.missing || worker.noAuth) {
				const saved = manager.getBranch().findLast((entry: any) => entry.customType === "pi-goals-state") as any;
				expect(saved.data).toMatchObject({ phase: "planning", modelRecovery: "worker" });
				expect(wires.some(w => w.t === "plan_activate" || w.t === "view")).toBe(false);
				expect(supervisor.messages).toEqual([]);
				expect(worker.messages.some((m: string) => m.startsWith("Work the goals"))).toBe(false);
				expect(worker.ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("worker model paused"), "error");
				await worker.hook("session_start", { reason: "reload" });
				expect(worker.ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("/goals model current"), "error");
				const before = worker.messages.length;
				worker.receive({ type: "message", fromSessionId: supervisor.id, payload: { t: "directive", to: worker.id, text: "Do not revive an inactive worker" } });
				await tick(); expect(worker.messages).toHaveLength(before);
				worker.missing = false; worker.noAuth = false;
				if (scenario.includes("during recovery restore")) {
					worker.deferWorkerRestore = true;
					const startupCount = herdrCalls.length;
					const recovering = worker.hook("agent_settled");
					await vi.waitFor(() => expect(worker.finishRestore).toBeTypeOf("function"));
					const clearing = scenario.startsWith("clear");
					await worker.commands.get("goals").handler(clearing ? "clear" : "plan replacement has no Ready", worker.ctx);
					worker.finishRestore(); await recovering; await tick();
					expect(herdrCalls).toHaveLength(startupCount);
					expect(wires.some(w => w.t === "plan_activate")).toBe(false);
					expect(worker.messages.some((m: string) => m.startsWith("Work the goals"))).toBe(false);
					expect(manager.getBranch().findLast((entry: any) => entry.customType === "pi-goals-state").data).toMatchObject({ phase: clearing ? null : "planning", planVersion: clearing ? null : 2, supervisor: null, modelRecovery: null });
					expect(worker.ctx.model.id).toBe("planning");
					return;
				}
				await worker.pi.setModel({ provider: "offline", id: "recovered-worker", contextWindow: 200_000 });
				await vi.waitFor(() => expect(worker.messages.filter((m: string) => m.startsWith("Work the goals"))).toHaveLength(1));
				expect(JSON.parse(readFileSync(join(modelDir, "worker-model.json"), "utf8"))).toEqual({ provider: "offline", id: "recovered-worker" });
				expect(JSON.parse(readFileSync(join(modelDir, "planning-model.json"), "utf8"))).toEqual({ provider: "offline", id: "planning" });
				expect(wires.filter(w => w.t === "plan_activate")).toHaveLength(1);
				expect(herdrCalls.filter(args => args[1] === "start")).toHaveLength(1);
				return;
			}
			if (scenario.includes("while model unavailable")) {
				worker.noAuth = true;
				await worker.hook("session_start", { reason: "reload" });
				await worker.commands.get("goals").handler(scenario.startsWith("clear") ? "clear" : "steward off", worker.ctx);
				await tick();
				for (const peer of peers) expect(peer.manager.getBranch().findLast((e: any) => e.customType === "supervise-state").data.role).toBe("none");
				const before = worker.messages.length;
				worker.receive({ type: "message", fromSessionId: supervisor.id, payload: { t: "directive", to: worker.id, text: "An old directive must not revive work" } });
				await tick(); expect(worker.messages).toHaveLength(before);
				expect(supervisor.aborts).toBeGreaterThan(0);
				return;
			}
			expect(supervisor).toBeDefined(); expect(supervisor.manager.getSessionFile()).not.toBe(manager.getSessionFile());
			expect(supervisor.manager.getBranch().some((e: any) => e.customType === SUPERVISOR_ROLE)).toBe(true);
			expect(supervisor.compactionModels).toEqual(["supervisor"]);
			expect(supervisor.manager.getBranch().some((entry: any) => entry.type === "model_change" && entry.modelId === "worker")).toBe(false);
			expect(supervisor.manager.getBranch().some((entry: any) => entry.type === "model_change" && entry.modelId === "planning")).toBe(true);
			expect(worker.ctx.model.id).toBe("worker");
			expect(JSON.parse(readFileSync(join(modelDir, "planning-model.json"), "utf8"))).toEqual({ provider: "offline", id: "planning" });
			expect(supervisor.compactions).toBe(1); expect(worker.compactions).toBe(0);
			expect(worker.messages.filter((m: string) => m.startsWith("Work the goals"))).toHaveLength(1);
			expect(supervisor.pi.getActiveTools()).not.toContain("CompleteGoal");
			await worker.commands.get("goals").handler("judge offline/judge", worker.ctx);
			for (const goal of ["first", "second"]) {
				const completion = worker.tools.get("CompleteGoal").execute("", { goal }, undefined, undefined, worker.ctx);
				await tick(); const request = wires.findLast((w: any) => w.t === "goal_review");
				expect(request.goal).toBe(goal);
				await supervisor.tools.get("review_goal").execute("", { requestId: request.requestId, decision: "approve", reason: "Within the requested scope" });
				const completed = await completion;
				expect(completed.isError, JSON.stringify(completed)).toBe(false);
				expect(readFileSync(path, "utf8")).toContain(`[x] goal: ${goal}`);
			}
			expect(judge.calls).toHaveLength(2); expect(judge.calls.every(args => args.includes("--no-extensions") && args.includes("offline/judge"))).toBe(true);
			expect(worker.ctx.model.id).toBe("worker");
			expect(supervisor.ctx.model.id).toBe("supervisor");
			expect(wires.some(w => w.t === "done")).toBe(false);
			await worker.commands.get("goals").handler("supervisor", worker.ctx);
			expect(herdrCalls.at(-1)).toEqual(["agent", "focus", "w1:p2"]);
			await supervisor.commands.get("goals").handler("worker", supervisor.ctx);
			expect(herdrCalls.at(-1)).toEqual(["agent", "focus", "w1:p1"]);
			const pending = worker.tools.get("CompleteGoal").execute("", { goal: "first" }, undefined, undefined, worker.ctx);
			await tick(); await worker.commands.get("goals").handler("steward off", worker.ctx);
			expect((await pending).isError).toBe(true); await tick();
			expect(judge.calls).toHaveLength(2); expect(supervisor.aborts).toBeGreaterThan(0);
		} finally { for (const peer of peers) await peer.hook("session_shutdown"); rmSync(cwd, { recursive: true, force: true }); }
	}, 15_000);
});
