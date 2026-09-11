import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, expect, it, vi } from "vitest";
import goalsExtension from "../src/index.js";
import { scheduleCheckIn } from "../src/prompts.js";

const roots: string[] = [];
const shutdowns: Array<() => void> = [];
afterEach(() => { for (const shutdown of shutdowns.splice(0)) shutdown(); vi.unstubAllEnvs(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(predicate: () => boolean, ms = 1500): Promise<void> {
	const start = Date.now();
	while (!predicate()) {
		if (Date.now() - start > ms) throw new Error("timed out waiting for condition");
		await delay(10);
	}
}
function fixture(child = false) {
	vi.stubEnv("PI_SUBAGENT_AGENT", child ? "goals-worker" : "");
	const cwd = mkdtempSync(join(tmpdir(), "goals-main-test-")); roots.push(cwd);
	const entries: any[] = []; const hooks = new Map<string, any>(); const commands = new Map<string, any>(); const tools = new Map<string, any>();
	const messages: any[] = [];
	const ctx = { cwd, sessionManager: { getBranch: () => entries, getSessionId: () => "copy-only" }, hasUI: true, ui: {
		theme: { fg: (_color: string, text: string) => text }, notify: vi.fn(), setStatus: vi.fn(), setWidget: vi.fn(), select: vi.fn(async () => "Ready"), editor: vi.fn(),
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
	goalsExtension(pi as unknown as ExtensionAPI);
	hooks.get("session_start")({}, ctx);
	const command = (value: string) => commands.get("goals").handler(value, ctx);
	const path = join(cwd, ".pi/plan/copy-only-main.md");
	const plan = "# Plan\n- [ ] goal: first output\n- [ ] goal: second output\n\n## Log\n";
	const draft = async () => { await command("new two outputs"); writeFileSync(path, plan); };
	const shutdown = () => hooks.get("session_shutdown")();
	shutdowns.push(shutdown);
	const changed = () => messages.filter((m) => m.message?.content?.includes("Plan changed")).length;
	const atomicWrite = async (text: string) => {
		const tmp = `${path}.tmp`;
		writeFileSync(tmp, text);
		renameSync(tmp, path);
		await delay(25);
	};
	return { ctx, pi, hooks, tools, commands, messages, command, path, plan, draft, shutdown, changed, atomicWrite, entries };
}

it("shows action choices and autocomplete without starting work", async () => {
	const f = fixture();
	f.ctx.ui.select.mockResolvedValueOnce(undefined as any);
	await f.command("");
	expect(f.ctx.ui.select).toHaveBeenCalledWith("Goal plan actions", expect.arrayContaining(["new — New plan", "resume — Continue paused work"]));
	expect(f.messages).toHaveLength(0);
	expect(f.commands.get("goals").getArgumentCompletions("res")).toEqual([{ value: "resume", label: "resume" }]);
});

it.each(["redy", "start", "two outputs", "status extra", "attach some.md solo extra"])("rejects %s without changing the plan or sending a model prompt", async (text) => {
	const f = fixture(); await f.draft();
	const before = readFileSync(f.path, "utf8");
	const entries = f.entries.length; const messages = f.messages.length;
	await f.command(text);
	expect(readFileSync(f.path, "utf8")).toBe(before);
	expect(f.entries).toHaveLength(entries);
	expect(f.messages).toHaveLength(messages);
});

it("requires a model argument without clearing the preference", async () => {
	const f = fixture(); await f.draft(); await f.command("model provider/model");
	const before = readFileSync(f.path, "utf8");
	await f.command("model");
	expect(readFileSync(f.path, "utf8")).toBe(before);
});

it.each(["menu", "command"])("enters planning conversation through %s without an objective box or worker launch", async (route) => {
	const f = fixture();
	f.ctx.ui.select.mockResolvedValueOnce("new — New plan");
	await f.command(route === "menu" ? "" : "new");
	expect(f.entries.at(-1).data.mode).toBe("planning");
	expect(f.ctx.ui.editor).not.toHaveBeenCalled();
	expect(f.messages.at(-1).message.content).toContain("Ask what the user wants to achieve");
	expect(f.hooks.get("tool_call")({ toolName: "subagent" }).block).toBe(true);
});

it("automatically proposes a changed settled draft once and preserves Discuss", async () => {
	const f = fixture(); await f.draft();
	f.ctx.ui.select.mockResolvedValueOnce("Discuss");
	await f.hooks.get("agent_settled")({}, f.ctx);
	expect(f.messages.some(m => m.message.customType === "goal-plan-proposal" && m.message.content === f.plan)).toBe(true);
	expect(f.entries.at(-1).data.mode).toBe("planning");
	const calls = f.ctx.ui.select.mock.calls.length;
	await f.hooks.get("agent_settled")({}, f.ctx);
	expect(f.ctx.ui.select).toHaveBeenCalledTimes(calls);
	writeFileSync(f.path, f.plan.replace("first output", "revised output"));
	f.ctx.ui.select.mockResolvedValueOnce("Ready");
	await f.hooks.get("agent_settled")({}, f.ctx);
	expect(f.entries.at(-1).data.mode).toBe("supervising");
});

it("does not propose an empty draft or a delegated worker's plan", async () => {
	const f = fixture(); await f.command("new");
	await f.hooks.get("agent_settled")({}, f.ctx);
	expect(f.ctx.ui.select).not.toHaveBeenCalled();
	const child = fixture(true); await child.hooks.get("agent_settled")({}, child.ctx);
	expect(child.ctx.ui.select).not.toHaveBeenCalled();
});

it("keeps Ready in the same chat, sends saved notices and never installs a context hook", async () => {
	const f = fixture(); await f.draft(); await f.command("review");
	expect(f.entries.at(-1).data.mode).toBe("supervising");
	expect(f.messages.at(-1).options).toEqual({ deliverAs: "followUp" });
	expect(f.messages.at(-1).savedPrompt).toBe(true);
	expect(f.messages.at(-1).message.content).toContain("goals-worker");
	expect(f.hooks.has("context")).toBe(false);
	const event = { systemPrompt: "original system" };
	expect(f.hooks.get("before_agent_start")(event, f.ctx).systemPrompt).toContain("original system");
	f.hooks.get("session_compact")();
	expect(f.hooks.get("before_agent_start")(event, f.ctx).message.content).toContain("Current goal mode: supervising");
	f.shutdown();
});

it("preserves a draft when the wrong subagent package is loaded, and offers explicit solo", async () => {
	const f = fixture(); await f.draft(); f.pi.getAllTools.mockReturnValue([]);
	await f.command("ready"); expect(f.entries.at(-1).data.mode).toBe("planning");
	f.ctx.ui.select.mockResolvedValueOnce("Worker confirmed stopped");
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

it.each(["FIRST OUTPUT", "renamed output", "duplicate", "historical"])("completion uses exact current subjects (%s)", async (subject) => {
	const f = fixture(); await f.draft(); await f.command("ready");
	const evidence = join(f.ctx.cwd, "verification.txt"); writeFileSync(evidence, "PASS");
	const suffix = subject === "duplicate" ? "- [ ] goal: first output\n" : "";
	const history = "## Log\n- [ ] goal: first output\n";
	writeFileSync(f.path, "- [ ] goal: first output\n  - [ ] unrelated task\n" + suffix + history);
	const before = readFileSync(f.path, "utf8");
	await f.tools.get("CompleteGoal").execute("c", { goal: subject === "duplicate" || subject === "historical" ? "first output" : subject, evidence: [evidence], observation: "Read actual output" }, undefined, undefined, f.ctx);
	const after = readFileSync(f.path, "utf8");
	if (subject === "renamed output" || subject === "duplicate") expect(after).toBe(before);
	else { expect(after).toContain("- [x] goal: first output"); expect(after.split("## Log")[1]).toContain("\n- [ ] goal: first output\n"); expect(after).toContain("- [ ] unrelated task"); }
});

it("rejects an existing zero-byte evidence file", async () => {
	const f = fixture(); await f.draft(); await f.command("ready");
	const evidence = join(f.ctx.cwd, "empty.log"); writeFileSync(evidence, "");
	const before = readFileSync(f.path, "utf8");
	const result = await f.tools.get("CompleteGoal").execute("c", { goal: "first output", evidence: [evidence], observation: "claim" }, undefined, undefined, f.ctx);
	expect(result.content[0].text).toContain("Empty evidence"); expect(readFileSync(f.path, "utf8")).toBe(before);
});

it("requires actual nonempty evidence, distinguishes manual ticks, and retains signoffs on reload", async () => {
	const f = fixture(); await f.draft(); await f.command("ready");
	const complete = (goal: string, evidence: string[], signal?: AbortSignal) => f.tools.get("CompleteGoal").execute("t", { goal, evidence, observation: "Inspected exact saved bytes" }, signal, undefined, f.ctx);
	expect((await complete("first output", ["missing.log"])).content[0].text).toContain("Evidence unavailable");
	mkdirSync(join(f.ctx.cwd, "evidence")); writeFileSync(join(f.ctx.cwd, "evidence/pass.log"), "actual fixture bytes\n");
	expect((await complete("first output", ["evidence/pass.log"], AbortSignal.abort())).content[0].text).toContain("Cancelled");
	await complete("first output", ["evidence/pass.log"]);
	writeFileSync(f.path, readFileSync(f.path, "utf8").replace("[ ] goal: second", "[x] goal: second"));
	f.hooks.get("session_start")({}, f.ctx);
	expect(f.ctx.ui.setStatus).toHaveBeenLastCalledWith("goals", "goals: supervising | 1/2 reviewed");
	expect(f.ctx.ui.setWidget.mock.lastCall?.[1]).toContain("? = completion claim; parent review still required");
	writeFileSync(f.path, readFileSync(f.path, "utf8").replace("[x] goal: first", "[ ] goal: first"));
	f.hooks.get("agent_end")({}, f.ctx);
	expect(f.ctx.ui.setStatus).toHaveBeenLastCalledWith("goals", "goals: supervising | 0/2 reviewed");
	f.shutdown();
});

it("reviews a plan replaced atomically, and ignores writes that keep the same content", async () => {
	const f = fixture(); await f.draft(); await f.command("ready");
	await f.atomicWrite(f.plan.replace("## Log", "- discriminator: changed requirement\n## Log"));
	await waitFor(() => f.changed() === 1);
	const review = f.messages.find((m) => m.message.content.includes("Plan changed"))?.message.content;
	expect(review).toContain("Plan changed: ");
	expect(review).toContain(f.path);
	await f.atomicWrite(f.plan.replace("## Log", "- discriminator: same requirement again\n## Log"));
	await waitFor(() => f.changed() === 2);
	// Rewriting identical bytes must not retrigger the review event hook.
	const same = f.plan.replace("## Log", "- discriminator: same requirement again\n## Log");
	writeFileSync(f.path, same); await delay(300);
	expect(f.changed()).toBe(2);
	f.shutdown();
});

it("coalesces duplicate plan-change notifications into one review", async () => {
	const f = fixture(); await f.draft(); await f.command("ready");
	await f.atomicWrite(f.plan.replace("## Log", "- discriminator: first burst edit\n## Log"));
	await f.atomicWrite(f.plan.replace("## Log", "- discriminator: second burst edit\n## Log"));
	await waitFor(() => f.changed() === 1);
	await delay(200);
	expect(f.changed()).toBe(1);
	f.shutdown();
});

it("stops plan watching on shutdown and re-arms it on reload without duplicating events", async () => {
	const f = fixture(); await f.draft(); await f.command("ready");
	f.shutdown();
	await f.atomicWrite(f.plan.replace("## Log", "- discriminator: ignored while shut down\n## Log"));
	await delay(150);
	expect(f.changed()).toBe(0);
	f.hooks.get("session_start")({}, f.ctx);
	await f.atomicWrite(f.plan.replace("## Log", "- discriminator: seen after reload\n## Log"));
	await waitFor(() => f.changed() === 1);
	expect(f.changed()).toBe(1);
	f.shutdown();
});

it("does not retrigger a review for its own CompleteGoal plan write", async () => {
	const f = fixture(); await f.draft(); await f.command("ready");
	mkdirSync(join(f.ctx.cwd, "evidence")); writeFileSync(join(f.ctx.cwd, "evidence/pass.log"), "bytes\n");
	await f.tools.get("CompleteGoal").execute("t", { goal: "first output", evidence: ["evidence/pass.log"], observation: "inspected" }, undefined, undefined, f.ctx);
	await delay(200);
	expect(f.changed()).toBe(0);
	f.shutdown();
});

it("gives pause/exit the session-bound scheduler job removal guidance", async () => {
	const f = fixture(); await f.draft(); await f.command("ready");
	await f.command("stop");
	const stop = f.messages.at(-1).message.content;
	expect(stop).toContain('goals-copy-only"');
	expect(stop).toContain("Do not add, enable or recreate any job");
	expect(stop).not.toContain("interval '1h'");
	expect(stop).toContain("Remote stop is NOT yet confirmed");
	await f.command("resume");
	await f.command("exit");
	expect(f.messages.at(-1).message.content).toContain('goals-copy-only"');
	expect(f.entries.at(-1).data.mode).toBe("chat");
});

it("tells the model to remove only its own job after the final review", async () => {
	const f = fixture(); await f.draft(); await f.command("ready");
	mkdirSync(join(f.ctx.cwd, "evidence")); writeFileSync(join(f.ctx.cwd, "evidence/pass.log"), "bytes\n");
	let finalText = "";
	for (const goal of ["first output", "second output"]) {
		finalText = (await f.tools.get("CompleteGoal").execute("t", { goal, evidence: ["evidence/pass.log"], observation: "inspected" }, undefined, undefined, f.ctx)).content[0].text;
	}
	expect(finalText).toContain("All non-cancelled goals are reviewed.");
	expect(finalText).toContain('job named "goals-copy-only"');
	expect(finalText).toContain("leave other jobs untouched");
	f.shutdown();
});

it("retains human-edited and disabled owned schedules without overriding their controls", () => {
	const guidance = scheduleCheckIn("copy-only", ".pi/plan/copy-only-main.md");
	expect(guidance).toContain("List first");
	expect(guidance).toContain("enabled/disabled state unchanged");
	expect(guidance).toContain("never recreate, overwrite or re-enable");
	expect(guidance).toContain("no model override");
	expect(guidance).toContain("Do not reinstall a missing job from a scheduled check-in");
	expect(guidance).toContain("/schedule-prompts");
});

it("restores context after compaction without reinstalling or overriding scheduler jobs", async () => {
	const f = fixture(); await f.draft(); await f.command("ready");
	f.hooks.get("session_compact")();
	const result = f.hooks.get("before_agent_start")({ systemPrompt: "base" }, f.ctx);
	expect(result.systemPrompt).not.toContain("add one session-bound");
	expect(result.message.content).toContain(f.path);
});

it("recovers from an unreadable plan after compaction instead of restarting work", async () => {
	const f = fixture(); await f.draft(); await f.command("ready");
	rmSync(f.path);
	f.hooks.get("session_compact")();
	const result = f.hooks.get("before_agent_start")({ systemPrompt: "base" }, f.ctx);
	expect(result.systemPrompt).toContain("ENOENT");
	expect(result.systemPrompt).toContain("do not restart completed work");
	writeFileSync(f.path, f.plan);
	expect(f.hooks.get("before_agent_start")({ systemPrompt: "base" }, f.ctx).message.content).toContain(f.plan.trim());
	f.shutdown();
});

it("requires confirmed worker stop before solo takeover and never lets two writers run together", async () => {
	const f = fixture(); await f.draft(); await f.command("ready");
	f.hooks.get("tool_result")({ toolName: "subagent", details: { id: "child-1", sessionFile: "/tmp/child.jsonl" } });
	f.ctx.ui.select.mockResolvedValueOnce("Cancel");
	await f.command("solo");
	expect(f.entries.at(-1).data.mode).toBe("supervising"); // cancelled
	f.ctx.ui.select.mockResolvedValueOnce("Worker confirmed stopped");
	await f.command("solo");
	expect(f.entries.at(-1).data.mode).toBe("solo");
	expect(f.hooks.get("tool_call")({ toolName: "subagent" }).block).toBe(true);
	expect(f.hooks.get("tool_call")({ toolName: "subagent_resume" }).block).toBe(true);
	expect(f.hooks.get("tool_call")({ toolName: "subagent_kill" })).toBeUndefined();
	mkdirSync(join(f.ctx.cwd, "evidence")); writeFileSync(join(f.ctx.cwd, "evidence/pass.log"), "bytes\n");
	const text = (await f.tools.get("CompleteGoal").execute("t", { goal: "first output", evidence: ["evidence/pass.log"], observation: "inspected" }, undefined, undefined, f.ctx)).content[0].text;
	expect(text).toContain("self-verification");
});

it("attaches an existing plan without restarting completed work, and restores its noted worker session", async () => {
	const f = fixture();
	const existing = join(f.ctx.cwd, "existing.md");
	writeFileSync(existing, "# Plan\n- preferred worker model: deepseek flash\n- worker session: /tmp/attach-child.jsonl\n- [ ] goal: attached goal\n\n## Log\n- previous progress kept\n");
	f.ctx.ui.select.mockResolvedValueOnce("Previous supervisor confirmed stopped");
	await f.command(`attach ${existing}`);
	expect(f.entries.at(-1).data.mode).toBe("planning");
	expect(f.entries.at(-1).data.plan).toBe(existing);
	expect(f.messages.at(-1).message.content).toContain("without restarting completed work");
	expect(f.messages.at(-1).message.content).toContain("/tmp/attach-child.jsonl");
});

it("attaches directly into solo mode and reports the recorded session in status", async () => {
	const f = fixture();
	const existing = join(f.ctx.cwd, "existing.md");
	writeFileSync(existing, "# Plan\n- worker session: /tmp/attach-child.jsonl\n- [ ] goal: attached goal\n\n## Log\n");
	f.ctx.ui.select.mockResolvedValueOnce("Worker confirmed stopped");
	await f.command(`attach ${existing} solo`);
	expect(f.entries.at(-1).data.mode).toBe("solo");
	expect(f.entries.at(-1).data.worker?.sessionFile).toBe("/tmp/attach-child.jsonl");
	await f.command("status");
	expect(f.ctx.ui.notify).toHaveBeenLastCalledWith(expect.stringContaining("/tmp/attach-child.jsonl"), "info");
});

it("rejects attaching a missing or goal-less file", async () => {
	const f = fixture();
	await f.command("attach /no/such/plan.md");
	expect(f.ctx.ui.notify).toHaveBeenLastCalledWith(expect.stringContaining("Cannot read plan"), "error");
	const goalLess = join(f.ctx.cwd, "notes.md");
	writeFileSync(goalLess, "# notes\n");
	await f.command(`attach ${goalLess}`);
	expect(f.ctx.ui.notify).toHaveBeenLastCalledWith(expect.stringContaining("has no '- [ ] goal:' lines"), "warning");
	expect(f.entries).toEqual([]); // nothing saved: the session was not attached
});

it("exits planning with the draft preserved and nothing implemented", async () => {
	const f = fixture(); await f.draft();
	await f.command("stop");
	expect(f.ctx.ui.notify).toHaveBeenLastCalledWith(expect.stringContaining("A draft cannot pause"), "warning");
	const before = f.messages.length;
	await f.command("exit");
	expect(f.entries.at(-1).data.mode).toBe("chat");
	expect(readFileSync(f.path, "utf8")).toContain("first output");
	expect(f.messages.length).toBe(before); // notify only, no model turn started
	f.ctx.ui.select.mockResolvedValueOnce("Previous supervisor confirmed stopped");
	await f.command(`attach ${f.path}`);
	expect(f.entries.at(-1).data.mode).toBe("planning");
});

it("records the preferred worker model as a visible plan preference", async () => {
	const f = fixture(); await f.draft();
	await f.command("model deepseek flash");
	expect(readFileSync(f.path, "utf8")).toContain("- preferred worker model: deepseek flash");
	await f.command("status");
	expect(f.ctx.ui.notify).toHaveBeenLastCalledWith(expect.stringContaining("deepseek flash"), "info");
});

it.each(["solo", "attach"])("%s takeover cannot bypass confirmation or survive a lifecycle change during the menu", async kind => {
	const f = fixture(); await f.draft(); await f.command("ready");
	f.hooks.get("tool_result")({ toolName: "subagent", details: { id: "child", sessionFile: "/tmp/prior.jsonl" } });
	let answer!: (choice: string) => void;
	f.ctx.ui.select.mockImplementationOnce(() => new Promise(resolve => { answer = resolve; }));
	const takeover = f.command(kind === "solo" ? "solo" : `attach ${f.path} solo`);
	expect(f.entries.at(-1).data.mode).toBe("supervising");
	await f.command("stop");
	answer("Worker confirmed stopped"); await takeover;
	expect(f.entries.at(-1).data.mode).toBe("paused");
	expect(f.entries.at(-1).data.workerStopped).not.toBe(true);
});

it("attach solo requires stop confirmation for a noted worker even in a fresh session", async () => {
	const f = fixture(); const path = join(f.ctx.cwd, "saved.md");
	writeFileSync(path, `# Plan\n- worker session: /tmp/known.jsonl\n${f.plan}`);
	f.ctx.ui.select.mockResolvedValueOnce("Cancel");
	await f.command(`attach ${path} solo`);
	expect(f.entries).toHaveLength(0);
	f.ctx.ui.select.mockResolvedValueOnce("Worker confirmed stopped");
	await f.command(`attach ${path} solo`);
	expect(f.entries.at(-1).data).toMatchObject({ mode: "solo", workerStopped: true, worker: { sessionFile: "/tmp/known.jsonl" } });
	expect(readFileSync(path, "utf8")).toContain("worker session: /tmp/known.jsonl");
});

it("retains the stopped session reference without permanently blocking another plan", async () => {
	const f = fixture(); await f.draft(); await f.command("ready");
	f.hooks.get("tool_result")({ toolName: "subagent", details: { id: "child", sessionFile: "/tmp/prior.jsonl" } });
	f.ctx.ui.select.mockResolvedValueOnce("Worker confirmed stopped"); await f.command("solo");
	const other = join(f.ctx.cwd, "another.md"); writeFileSync(other, "- [ ] goal: next\n## Log\n");
	f.ctx.ui.select.mockResolvedValueOnce("Previous supervisor confirmed stopped");
	await f.command(`attach ${other}`);
	expect(f.entries.at(-1).data).toMatchObject({ mode: "planning", plan: other, workerStopped: true, worker: { sessionFile: "/tmp/prior.jsonl" } });
	await f.command("ready");
	f.hooks.get("tool_call")({ toolName: "subagent_resume" });
	expect(f.entries.at(-1).data.workerStopped).toBe(false);
	await f.command("solo");
	expect(f.ctx.ui.notify).toHaveBeenLastCalledWith(expect.stringContaining("still pending"), "warning");
});

it("solo closes a pending plan watcher and sends removal-only scheduler guidance", async () => {
	const f = fixture(); await f.draft(); await f.command("ready");
	await f.atomicWrite(f.plan.replace("first output", "changed output"));
	f.ctx.ui.select.mockResolvedValueOnce("Worker confirmed stopped"); await f.command("solo");
	expect(f.messages.at(-1).message.content).toContain('job named "goals-copy-only" bound to session "copy-only"');
	expect(f.messages.at(-1).message.content).toContain("Do not add, enable or recreate any job");
	await delay(250);
	await f.atomicWrite(f.plan.replace("first output", "solo output"));
	await delay(250);
	expect(f.changed()).toBe(0);
});

it.each(["missing", "empty", "directory"])("%s plan snapshots never erase signoffs and resync retries after repair", async failure => {
	const f = fixture(); await f.draft(); await f.command("ready");
	writeFileSync(join(f.ctx.cwd, "proof.log"), "PASS\n");
	await f.tools.get("CompleteGoal").execute("c", { goal: "first output", evidence: ["proof.log"], observation: "Observed PASS" }, undefined, undefined, f.ctx);
	const signed = readFileSync(f.path, "utf8");
	if (failure === "empty") writeFileSync(f.path, "");
	else { rmSync(f.path); if (failure === "directory") mkdirSync(f.path); }
	await delay(250); // also exercise unavailable read after debounce has expired
	f.hooks.get("agent_end")({}, f.ctx);
	expect(f.entries.at(-1).data.signoffs["first output"]).toBeDefined();
	f.hooks.get("session_compact")();
	const unavailable = f.hooks.get("before_agent_start")({ systemPrompt: "base" }, f.ctx);
	expect(unavailable.systemPrompt).toContain("unavailable");
	expect(unavailable.message).toBeUndefined();
	if (failure === "directory") rmSync(f.path, { recursive: true });
	writeFileSync(f.path, signed);
	const resync = f.hooks.get("before_agent_start")({ systemPrompt: "base" }, f.ctx);
	expect(resync.message.content).toContain("Observed PASS");
	await delay(250);
	expect(f.entries.at(-1).data.signoffs["first output"]).toBeDefined();
	expect(f.changed()).toBe(0);
});

it("ignores post-completion maintenance but reviews evidence, requirement or manual reopening changes", async () => {
	const f = fixture(); await f.draft(); await f.command("ready");
	writeFileSync(join(f.ctx.cwd, "proof.log"), "PASS\n");
	for (const goal of ["first output", "second output"]) await f.tools.get("CompleteGoal").execute("c", { goal, evidence: ["proof.log"], observation: "PASS" }, undefined, undefined, f.ctx);
	const signed = readFileSync(f.path, "utf8");
	await f.atomicWrite(signed.replace("## Log", "## Log\n- recap: finished"));
	await delay(250);
	expect(f.changed()).toBe(0); // Log-only edits are history, not requirements
	// Worker-authored evidence above the Log must surface: a supervisor caught a worker's
	// contradictory evidence block through exactly this event (LUCID3, 2026-09-10).
	await f.atomicWrite(signed.replace("## Log", "  - evidence: proof.log\n## Log\n- recap: finished"));
	await waitFor(() => f.changed() === 1);
	await f.atomicWrite(signed.replace("## Log", "- discriminator: exact bytes and trailing newline\n## Log"));
	await waitFor(() => f.changed() === 2);
	await f.atomicWrite(signed.replace("[x] goal: first", "[ ] goal: first"));
	await waitFor(() => f.changed() === 3);
	expect(f.entries.at(-1).data.signoffs["first output"]).toBeUndefined();
});

it("cancelled goals do not prevent final cleanup, and solo writes self-verification in Log", async () => {
	const f = fixture(); await f.draft();
	writeFileSync(f.path, f.plan.replace("[ ] goal: second", "[-] goal: second") + "\n## Appendix\nPreserved context\n");
	f.ctx.ui.select.mockResolvedValueOnce("Worker confirmed stopped"); await f.command("solo");
	writeFileSync(join(f.ctx.cwd, "proof.log"), "PASS\n");
	const done = await f.tools.get("CompleteGoal").execute("c", { goal: "first output", evidence: ["proof.log"], observation: "Exact bytes observed" }, undefined, undefined, f.ctx);
	expect(done.content[0].text).toContain("All non-cancelled goals are reviewed");
	const text = readFileSync(f.path, "utf8");
	expect(text).toContain("Solo self-verification:");
	expect(text).not.toContain("Parent review:");
	expect(text.indexOf("Solo self-verification:")).toBeLessThan(text.indexOf("## Appendix"));
	expect(text).toContain("Preserved context");
});

it("prefixes single and batch launch titles with the project without changing handles or duplicating prefixes", () => {
	const f = fixture();
	const single = { name: "report-worker", title: "Restore PCA" };
	const event = { toolName: "subagent", input: single };
	f.hooks.get("tool_call")(event, f.ctx);
	const expected = `${f.ctx.cwd.split("/").at(-1)} · Restore PCA`;
	expect(single).toEqual({ name: "report-worker", title: expected });
	f.hooks.get("tool_call")(event, f.ctx);
	expect(single.title).toBe(expected);
	const children = [{ name: "test-worker", title: "Check results" }, { ...single }];
	f.hooks.get("tool_call")({ toolName: "subagent", input: { children } }, f.ctx);
	expect(children[0].title).toBe(`${f.ctx.cwd.split("/").at(-1)} · Check results`);
	expect(children[1]).toEqual(single);
});

it("lineage-only child attaches its plan without a widget, retains task context, and cannot complete", async () => {
	const f = fixture(true);
	const supplied = join(f.ctx.cwd, "supplied.md");
	const text = "- [/] goal: exact file\n  - [ ] verify bytes\n## Log\n  - [ ] archived task\n";
	writeFileSync(supplied, text);
	const before = f.hooks.get("before_agent_start")({ systemPrompt: "base" }, f.ctx);
	expect(before.systemPrompt).toContain("AttachGoalPlan");
	const attach = f.tools.get("AttachGoalPlan");
	await attach.execute("a", { path: "supplied.md" }, undefined, undefined, f.ctx);
	expect(f.entries.at(-1).data.plan).toBeUndefined(); // no cwd heuristics
	await attach.execute("a", { path: supplied }, undefined, undefined, f.ctx);
	expect(f.ctx.ui.setWidget).toHaveBeenLastCalledWith("goals", undefined);
	expect(readFileSync(supplied, "utf8")).toBe(text);
	f.hooks.get("session_start")({}, f.ctx);
	expect(f.ctx.ui.setWidget).toHaveBeenLastCalledWith("goals", undefined);
	expect(f.hooks.get("before_agent_start")({ systemPrompt: "base" }, f.ctx).message.content).toContain("exact file");
	const completion = await f.tools.get("CompleteGoal").execute("c", { goal: "exact file", evidence: [], observation: "claim" }, undefined, undefined, f.ctx);
	expect(completion.content[0].text).toContain("only to the active parent");
});

it.each(["solo", "supervising"])("%s widget omits long tasks without altering the plan", async mode => {
	const f = fixture(); await f.draft();
	const text = "- [/] goal: first output\n  - [ ] a long task that should never take widget space\n- [ ] goal: second output\n## Log\n";
	writeFileSync(f.path, text);
	if (mode === "solo") { f.ctx.ui.select.mockResolvedValueOnce("Worker confirmed stopped"); await f.command("solo"); }
	else await f.command("ready");
	expect(f.ctx.ui.setWidget.mock.lastCall?.[1]).toEqual(["▸ first output", "○ second output"]);
	expect(readFileSync(f.path, "utf8")).toBe(text);
});

it.each(["solo", "supervising"])("%s upkeep is turn-driven, folds Log, resets on working-set edits, and never starts a turn", async mode => {
	const f = fixture(); await f.draft();
	if (mode === "solo") { f.ctx.ui.select.mockResolvedValueOnce("Worker confirmed stopped"); await f.command("solo"); }
	else await f.command("ready");
	f.hooks.get("before_agent_start")({ systemPrompt: "base" }, f.ctx);
	const reminders = () => f.messages.filter(m => m.message.customType === "pi-goals-upkeep");
	f.hooks.get("turn_end")({}, f.ctx); // observe initial working set
	for (let i = 0; i < 7; i++) {
		writeFileSync(f.path, f.plan + `- historical recap ${i}\n`);
		f.hooks.get("turn_end")({}, f.ctx);
	}
	expect(reminders()).toHaveLength(0);
	f.hooks.get("turn_end")({}, f.ctx);
	expect(reminders()).toHaveLength(1);
	expect(reminders()[0].options).toEqual({ triggerTurn: false });
	expect(reminders()[0].message.content).toContain(f.path);
	expect(reminders()[0].message.content).not.toContain("first output");
	for (let i = 0; i < 16; i++) f.hooks.get("turn_end")({}, f.ctx);
	expect(reminders()).toHaveLength(1);
	expect(reminders()[0].message.content).not.toContain("historical recap");
	for (let i = 0; i < 7; i++) f.hooks.get("turn_end")({}, f.ctx);
	writeFileSync(f.path, f.plan.replace("first output", "refined output"));
	f.hooks.get("turn_end")({}, f.ctx);
	expect(reminders()).toHaveLength(1);
	await f.command("stop");
	for (let i = 0; i < 10; i++) f.hooks.get("turn_end")({}, f.ctx);
	expect(reminders()).toHaveLength(1);
});

it("extra subagent launches are recorded as helpers and never steal the implementation identity", async () => {
	const f = fixture(); await f.draft(); await f.command("ready");
	f.hooks.get("tool_result")({ toolName: "subagent", details: { id: "impl", sessionFile: "/tmp/impl.jsonl" } });
	expect(f.entries.at(-1).data).toMatchObject({ worker: { id: "impl", sessionFile: "/tmp/impl.jsonl" }, helpers: [] });
	f.hooks.get("tool_result")({ toolName: "subagent", details: { id: "reviewer", sessionFile: "/tmp/review.jsonl" } });
	expect(f.entries.at(-1).data).toMatchObject({ worker: { id: "impl" }, helpers: [{ id: "reviewer", sessionFile: "/tmp/review.jsonl" }] });
	// a repeated helper launch updates its record instead of duplicating it
	f.hooks.get("tool_result")({ toolName: "subagent", details: { id: "reviewer-2", sessionFile: "/tmp/review.jsonl" } });
	expect(f.entries.at(-1).data.helpers).toEqual([{ id: "reviewer-2", sessionFile: "/tmp/review.jsonl" }]);
	// resuming the worker keeps the binding and refreshes its id
	f.hooks.get("tool_result")({ toolName: "subagent_resume", details: { id: "impl-2", sessionFile: "/tmp/impl.jsonl" } });
	expect(f.entries.at(-1).data).toMatchObject({ worker: { id: "impl-2", sessionFile: "/tmp/impl.jsonl" }, helpers: [{ id: "reviewer-2" }] });
});

it("pending launch counter survives concurrent launches until every result lands", async () => {
	const f = fixture(); await f.draft(); await f.command("ready");
	f.hooks.get("tool_call")({ toolName: "subagent" });
	f.hooks.get("tool_call")({ toolName: "subagent" });
	f.hooks.get("tool_result")({ toolName: "subagent", details: { id: "a", sessionFile: "/tmp/a.jsonl" } });
	f.ctx.ui.select.mockResolvedValueOnce("Worker confirmed stopped");
	await f.command("solo");
	expect(f.entries.at(-1).data.mode).toBe("supervising"); // one launch still pending
	expect(f.ctx.notify ?? f.ctx.ui.notify).toHaveBeenLastCalledWith(expect.stringContaining("still pending"), "warning");
	f.hooks.get("tool_result")({ toolName: "subagent", details: { id: "b", sessionFile: "/tmp/b.jsonl" } });
	f.ctx.ui.select.mockResolvedValueOnce("Worker confirmed stopped");
	await f.command("solo");
	expect(f.entries.at(-1).data.mode).toBe("solo");
	expect(f.entries.at(-1).data).toMatchObject({ worker: { id: "a" }, helpers: [{ id: "b" }] });
});

it("late worker results invalidate a takeover menu but do not disable plan watching", async () => {
	const f = fixture(); await f.draft(); await f.command("ready");
	let answer!: (choice: string) => void;
	f.ctx.ui.select.mockImplementationOnce(() => new Promise(resolve => { answer = resolve; }));
	const solo = f.command("solo");
	f.hooks.get("tool_result")({ toolName: "subagent", details: { id: "late-child", sessionFile: "/tmp/late.jsonl" } });
	answer("Worker confirmed stopped"); await solo;
	expect(f.entries.at(-1).data.mode).toBe("supervising");
	expect(f.entries.at(-1).data.workerStopped).toBe(false);
	await f.atomicWrite(f.plan.replace("first output", "new requirement"));
	await waitFor(() => f.changed() === 1);
});

it("changed plan or shutdown during takeover never grants solo permission", async () => {
	const f = fixture(); await f.draft();
	f.ctx.ui.select.mockImplementationOnce(async () => { writeFileSync(f.path, f.plan.replace("first", "changed")); return "Worker confirmed stopped"; });
	await f.command("solo");
	expect(f.entries.at(-1).data.mode).toBe("planning");
	expect(f.ctx.ui.notify).toHaveBeenLastCalledWith(expect.stringContaining("Plan changed during takeover"), "warning");
	f.ctx.ui.select.mockImplementationOnce(async () => { f.shutdown(); return "Worker confirmed stopped"; });
	await f.command("solo");
	expect(f.entries.at(-1).data.mode).toBe("planning");
});

it("requires explicit supervisor ownership confirmation when attaching an existing plan", async () => {
	const f = fixture(); const path = join(f.ctx.cwd, "shared.md");
	writeFileSync(path, f.plan);
	f.ctx.ui.select.mockResolvedValueOnce("Cancel");
	await f.command(`attach ${path}`);
	expect(f.entries).toHaveLength(0);
	f.ctx.ui.select.mockResolvedValueOnce("Previous supervisor confirmed stopped");
	await f.command(`attach ${path}`);
	expect(f.entries.at(-1).data).toMatchObject({ mode: "planning", plan: path });
});

it("does not approve cancelled goals or display current completion for an unavailable plan", async () => {
	const f = fixture(); await f.draft(); await f.command("ready");
	writeFileSync(f.path, "- [-] goal: cancelled output\n## Log\n");
	writeFileSync(join(f.ctx.cwd, "evidence.log"), "verified\n");
	const reply = await f.tools.get("CompleteGoal").execute("t", { goal: "cancelled output", evidence: ["evidence.log"], observation: "read" }, undefined, undefined, f.ctx);
	expect(reply.content[0].text).toContain("no sign-off recorded");
	expect(readFileSync(f.path, "utf8")).toContain("[-]");
	rmSync(f.path);
	f.hooks.get("agent_end")({}, f.ctx);
	expect(f.ctx.ui.setWidget).toHaveBeenLastCalledWith("goals", [expect.stringContaining("unavailable")]);
});

it("uses scheduler storage for ownership and the real public user controls", () => {
	const prompt = scheduleCheckIn("session-1", "/plan.md");
	expect(prompt).toContain(".pi/schedule-prompts.json");
	expect(prompt).toContain("tool text does not expose binding");
	expect(prompt).toContain("Never use cleanup");
	expect(prompt).toContain("deletes disabled jobs");
	expect(prompt).toContain("schedule_prompt update");
	expect(prompt).not.toContain("with /schedule-prompts");
});

it("keeps interactive workers open and supplies the supervisor identity for Intercom reports", async () => {
	const agent = readFileSync(new URL("../agents/goals-worker.md", import.meta.url), "utf8");
	expect(agent).toContain("auto-exit: false");
	const f = fixture(); await f.draft(); await f.command("ready");
	expect(f.messages.at(-1).message.content).toContain("supervisor Intercom session copy-only");
	const role = f.hooks.get("before_agent_start")({ systemPrompt: "base" }, f.ctx).systemPrompt;
	expect(role).toContain("your Intercom session ID copy-only");
	expect(role).toContain("stop workers before /reload");
	expect(role).not.toContain("Reports arrive automatically");
});
