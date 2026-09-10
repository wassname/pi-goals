import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, expect, it, vi } from "vitest";
import prototype from "../src/prototype.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
	const cwd = mkdtempSync(join(tmpdir(), "goals-main-test-")); roots.push(cwd);
	const entries: any[] = []; const hooks = new Map<string, any>(); const commands = new Map<string, any>(); const tools = new Map<string, any>();
	const messages: any[] = [];
	const ctx = { cwd, sessionManager: { getBranch: () => entries, getSessionId: () => "copy-only" }, ui: {
		notify: vi.fn(), setStatus: vi.fn(), setWidget: vi.fn(), select: vi.fn(async () => "Ready"), editor: vi.fn(),
	} };
	const pi = {
		on: (event: string, hook: any) => hooks.set(event, hook),
		appendEntry: (customType: string, data: any) => entries.push({ type: "custom", customType, data: structuredClone(data) }),
		registerCommand: (name: string, definition: any) => commands.set(name, definition),
		registerTool: (definition: any) => tools.set(definition.name, definition),
		sendMessage: (message: any, options: any) => messages.push({ message, options }),
		sendUserMessage: (content: string, options: any) => messages.push({ message: { content }, options, savedPrompt: true }),
		getAllTools: vi.fn(() => [
			{ name: "subagent", parameters: { properties: { agent: {}, title: {} } } },
			{ name: "subagent_resume", parameters: { properties: { sessionFile: {} } } },
			{ name: "subagent_kill", parameters: { properties: { id: {} } } },
		]),
	};
	prototype(pi as unknown as ExtensionAPI);
	hooks.get("session_start")({}, ctx);
	const command = (value: string) => commands.get("goals").handler(value, ctx);
	const path = join(cwd, ".pi/plan/copy-only-main.md");
	const plan = "# Plan\n- [ ] goal: first output\n- [ ] goal: second output\n\n## Log\n";
	const draft = async () => { await command("two outputs"); writeFileSync(path, plan); };
	return { ctx, pi, hooks, tools, messages, command, path, draft, entries };
}

it("keeps Ready in the same chat, sends saved notices and never installs a context hook", async () => {
	const f = fixture(); await f.draft(); await f.command("review");
	expect(f.entries.at(-1).data.mode).toBe("supervising");
	expect(f.messages.at(-1).options).toEqual({ deliverAs: "followUp" });
	expect(f.messages.at(-1).savedPrompt).toBe(true);
	expect(f.messages.at(-1).message.content).toContain("goals-worker");
	expect(f.hooks.has("context")).toBe(false);
	const event = { systemPrompt: "original system" };
	expect(f.hooks.get("before_agent_start")(event).systemPrompt).toContain("original system");
	f.hooks.get("session_compact")();
	expect(f.hooks.get("before_agent_start")(event).message.content).toContain("Current goal mode: supervising");
});

it("preserves a draft when the wrong subagent package is loaded, and offers explicit solo", async () => {
	const f = fixture(); await f.draft(); f.pi.getAllTools.mockReturnValue([]);
	await f.command("ready"); expect(f.entries.at(-1).data.mode).toBe("planning");
	await f.command("solo"); expect(f.entries.at(-1).data.mode).toBe("solo");
});

it("rejects a plan changed while the human was reviewing it", async () => {
	const f = fixture(); await f.draft();
	f.ctx.ui.select.mockImplementation(async () => { writeFileSync(f.path, "- [ ] goal: substituted\n"); return "Ready"; });
	await f.command("review"); expect(f.entries.at(-1).data.mode).toBe("planning");
});

it("reloads a paused plan without launching, and retains the public worker session handle", async () => {
	const f = fixture(); await f.draft(); await f.command("ready");
	f.hooks.get("tool_result")({ toolName: "subagent", details: { id: "child-1", sessionFile: "/tmp/child.jsonl" } });
	await f.command("stop");
	expect(f.messages.at(-1).message.content).toContain("Remote stop is NOT yet confirmed");
	f.hooks.get("session_start")({}, f.ctx);
	expect(f.hooks.get("tool_call")({ toolName: "subagent_resume" }).block).toBe(true);
	await f.command("resume");
	expect(f.messages.at(-1).message.content).toContain("/tmp/child.jsonl");
	await f.command("exit"); expect(f.entries.at(-1).data.mode).toBe("chat");
	expect(readFileSync(f.path, "utf8")).toContain("first output");
});

it("requires actual nonempty evidence, distinguishes manual ticks, and retains signoffs on reload", async () => {
	const f = fixture(); await f.draft(); await f.command("ready");
	const complete = (goal: string, evidence: string[], signal?: AbortSignal) => f.tools.get("CompleteGoal").execute("t", { goal, evidence, observation: "Inspected exact saved bytes" }, signal, undefined, f.ctx);
	expect((await complete("first output", ["missing.log"])).content[0].text).toContain("Evidence unavailable");
	mkdirSync(join(f.ctx.cwd,"evidence")); writeFileSync(join(f.ctx.cwd,"evidence/pass.log"),"actual fixture bytes\n");
	expect((await complete("first output", ["evidence/pass.log"], AbortSignal.abort())).content[0].text).toContain("Cancelled");
	await complete("first output", ["evidence/pass.log"]);
	writeFileSync(f.path, readFileSync(f.path,"utf8").replace("[ ] goal: second", "[x] goal: second"));
	f.hooks.get("session_start")({},f.ctx);
	expect(f.ctx.ui.setStatus).toHaveBeenLastCalledWith("goals", "goals: supervising | 1/2 reviewed");
	expect(f.ctx.ui.setWidget.mock.lastCall?.[1]).toContain("? = completion claim; parent review still required");
	writeFileSync(f.path,readFileSync(f.path,"utf8").replace("[x] goal: first", "[ ] goal: first"));
	f.hooks.get("agent_end")({},f.ctx);
	expect(f.ctx.ui.setStatus).toHaveBeenLastCalledWith("goals", "goals: supervising | 0/2 reviewed");
});
