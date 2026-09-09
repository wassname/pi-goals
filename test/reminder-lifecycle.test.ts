import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import piGoalsExtension from "../src/index.js";

// Point at the installed Pi package to exercise its real lifecycle, not the API mock.
const sdkRoot = process.env.PI_GOALS_TEST_SDK_ROOT ?? resolve("node_modules/@earendil-works/pi-coding-agent");
const sdk = await import(pathToFileURL(join(sdkRoot, "dist/index.js")).href);
const { loadExtensionFromFactory } = await import(pathToFileURL(join(sdkRoot, "dist/core/extensions/loader.js")).href);
const requireSdk = createRequire(join(sdkRoot, "package.json"));
const aiRoot = requireSdk.resolve.paths("@earendil-works/pi-ai")!.map(path => join(path, "@earendil-works/pi-ai")).find(path => existsSync(join(path, "package.json")))!;
const { convertResponsesMessages } = await import(pathToFileURL(join(aiRoot, "dist/api/openai-responses-shared.js")).href);
const sdkVersion = JSON.parse(readFileSync(join(sdkRoot, "package.json"), "utf8")).version;
// Optional read-only check against the real guard; no native endpoint or private checkpoint used.
const replay = process.env.PI_GOALS_TEST_REPLAY_ROOT
	? await import(pathToFileURL(join(process.env.PI_GOALS_TEST_REPLAY_ROOT, "src/payload-rewrite.ts")).href) : undefined;
const zeroCost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
const plan = (revision: string) => `# Plan ${revision}\n\n1. [/] goal: test saved reminders\n\n## Log\n- fixture log ${revision}\n\n## Appendix\nfixture appendix ${revision}\n`;
const compactReminder = (message: any) => typeof message.content === "string" && message.content.includes("The session was just compacted.");

async function setup(phase = "working") {
	sdk.initTheme("dark", false);
	const cwd = mkdtempSync(join(tmpdir(), "goals-reminder-sdk-"));
	const sm = sdk.SessionManager.create(cwd, join(cwd, "sessions"));
	const events: string[] = [];
	const requests: any[][] = [];
	const errors: unknown[] = [];
	let responses: Array<{ tool?: boolean; high?: boolean; overflow?: boolean; queue?: boolean }> = [];
	let compactions = 0;
	const settingsManager = sdk.SettingsManager.inMemory({ compaction: { enabled: false, reserveTokens: 1000, keepRecentTokens: 100 }, retry: { enabled: false } });
	const runtime = sdk.createExtensionRuntime();
	const bus = sdk.createEventBus();
	const extensions = [];
	extensions.push(await loadExtensionFromFactory(piGoalsExtension, cwd, bus, runtime));
	let session: any;
	extensions.push(await loadExtensionFromFactory((pi: any) => {
		pi.on("before_agent_start", () => { events.push("before_agent_start"); });
		pi.on("session_compact", (event: any) => { events.push(`compact:${event.reason}:${event.willRetry}`); });
		pi.on("session_before_compact", (event: any) => {
			compactions++;
			return { compaction: { summary: `Offline checkpoint ${compactions}`, firstKeptEntryId: event.preparation.firstKeptEntryId, tokensBefore: event.preparation.tokensBefore, details: { compactedWindow: [{ type: "compaction", encrypted_content: "offline-fixture-only" }] } } };
		});
		pi.registerTool({ name: "fixture_tool", label: "fixture", description: "Offline no-op", parameters: { type: "object", properties: {} }, execute: async () => ({ content: [{ type: "text", text: "fixture result" }], details: {} }) });
	}, cwd, bus, runtime));
	const resourceLoader = {
		getExtensions: () => ({ extensions, errors: [], runtime }),
		getSkills: () => ({ skills: [], diagnostics: [] }), getPrompts: () => ({ prompts: [], diagnostics: [] }), getThemes: () => ({ themes: [], diagnostics: [] }),
		getAgentsFiles: () => ({ agentsFiles: [] }), getSystemPrompt: () => "Offline reminder test", getSystemPromptSource: () => undefined,
		getAppendSystemPrompt: () => [], getAppendSystemPromptSources: () => [], extendResources: () => {}, reload: async () => {},
	};
	const modelRuntime = await sdk.ModelRuntime.create({ authPath: join(cwd, "auth.json"), modelsPath: join(cwd, "models.json"), modelsStorePath: join(cwd, "models-store.json"), allowModelNetwork: false });
	await modelRuntime.setRuntimeApiKey("openai", "offline-fixture-key");
	const model = { ...modelRuntime.getModel("openai", "gpt-4.1"), contextWindow: 10000 };
	expect(model.id).toBe("gpt-4.1");
	const assistant = (content: any[], stopReason = "stop", input = 100) => ({ role: "assistant", content, api: model.api, provider: model.provider, model: model.id, stopReason, usage: { input, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: input + 1, cost: zeroCost }, timestamp: Date.now() });
	sm.appendMessage({ role: "user", content: "Fixture history", timestamp: Date.now() - 1000 });
	sm.appendMessage({ ...assistant([{ type: "text", text: "Fixture history response" }]), timestamp: Date.now() - 900 });
	sm.appendCustomEntry("pi-goals-state", { defaultsVersion: 1, phase, planVersion: 1, stewardEnabled: false, autoIntervalMs: null, reviewRequested: false });
	const planPath = join(cwd, ".pi/plan", `${sm.getSessionId()}-v1.md`);
	mkdirSync(dirname(planPath), { recursive: true }); writeFileSync(planPath, plan("initial"));
	({ session } = await sdk.createAgentSession({ cwd, agentDir: process.env.PI_CODING_AGENT_DIR, model, modelRuntime, sessionManager: sm, settingsManager, resourceLoader, tools: ["fixture_tool"] }));
	session.subscribe((event: any) => {
		if (event.type === "message_end" && event.message.role === "assistant" && event.message.errorMessage && event.message.errorMessage !== "maximum context length exceeded") errors.push(event.message.errorMessage);
	});
	const serialize = (messages: any[]) => convertResponsesMessages(model, { messages: sdk.convertToLlm(messages) }, new Set(["openai", "openai-codex", "opencode"]));
	session.agent.streamFunction = async (_model: any, context: any) => {
		const actual = serialize(context.messages);
		const saved = serialize(sm.buildSessionContext().messages);
		expect(actual).toEqual(saved); // Provider-visible history matches saved history AT request time.
		const disk = sdk.SessionManager.open(sm.getSessionFile());
		expect(serialize(disk.buildSessionContext().messages)).toEqual(saved);
		const checkpoint = sm.getBranch().findLast((entry: any) => entry.type === "compaction");
		if (replay && checkpoint) {
			const args = { model, payload: { model: model.id, instructions: "Offline reminder test", input: actual }, branchEntries: sm.getBranch(), compactionEntry: checkpoint };
			expect(replay.rewriteResponsesPayloadWithNativeReplay(args).ok).toBe(true);
			// Negative control: the original ephemeral suffix must still be rejected by the guard.
			expect(replay.rewriteResponsesPayloadWithNativeReplay({ ...args, payload: { ...args.payload, input: [...actual, { role: "user", content: [{ type: "input_text", text: "<system-reminder>unsaved plan</system-reminder>" }] }] } })).toMatchObject({ ok: false, reason: "expected-pi-replay-mismatch" });
		}
		requests.push(structuredClone(context.messages));
		const next = responses.shift() ?? {};
		if (next.queue) await session.steer("Queued user must retain order");
		const message = assistant(next.tool ? [{ type: "toolCall", id: `fixture-${requests.length}`, name: "fixture_tool", arguments: {} }] : [{ type: "text", text: "Offline answer" }], next.overflow ? "error" : next.tool ? "toolUse" : "stop", next.high ? 9500 : 100);
		if (next.overflow) { message.errorMessage = "maximum context length exceeded"; message.usage.input = 0; }
		return { async *[Symbol.asyncIterator]() { yield next.overflow ? { type: "error", reason: "error", error: message } : { type: "done", reason: message.stopReason, message }; }, result: async () => message };
	};
	await session.bindExtensions({ onError: (error: unknown) => errors.push(error) });
	return {
		session, sm, events, requests, errors, planPath, settingsManager,
		respond: (...next: typeof responses) => { responses = next; },
		reminders: () => sm.getBranch().filter((entry: any) => entry.type === "custom_message" && compactReminder(entry)),
		close: () => { session.dispose(); rmSync(cwd, { recursive: true, force: true }); },
	};
}

describe(`saved goal reminders (Pi SDK ${sdkVersion}${replay ? ", real replay guard" : ""})`, () => {
	it.each(["working", "planning"])("manual compact in %s: fresh saved reminder once on next natural prompt", async (phase) => {
		const flow = await setup(phase);
		try {
			await flow.session.prompt("Initial request");
			const priorSnapshotIds = new Set(flow.sm.getBranch().filter((entry: any) => entry.type === "custom_message").map((entry: any) => entry.id));
			await flow.session.compact();
			const checkpointId = flow.sm.getBranch().findLast((entry: any) => entry.type === "compaction").id;
			expect(flow.events).toContain("compact:manual:false");
			expect(flow.requests).toHaveLength(1);
			writeFileSync(flow.planPath, plan("fresh-after-compact"));
			await flow.session.prompt("Natural request");
			const snapshots = flow.sm.getBranch().filter((entry: any) => entry.type === "custom_message" && entry.customType === (phase === "working" ? "pi-goals-plan-reminder" : "pi-goals-planning-context"));
			const count = snapshots.length;
			const latest = snapshots.at(-1);
			expect(latest.display).toBe(false);
			expect(priorSnapshotIds.has(latest.id)).toBe(false);
			const branch = flow.sm.getBranch();
			expect(branch.findIndex((entry: any) => entry.id === latest.id)).toBeGreaterThan(branch.findIndex((entry: any) => entry.id === checkpointId));
			expect(flow.requests[1].some((message: any) => message.role === "user" && Array.isArray(message.content) && message.content.some((part: any) => part.type === "text" && part.text === latest.content))).toBe(true);
			if (phase === "working") { expect(flow.reminders()).toHaveLength(1); expect(flow.reminders()[0].content).toContain("fixture appendix fresh-after-compact"); }
			await flow.session.prompt("Another natural request");
			expect(flow.sm.getBranch().filter((entry: any) => entry.type === "custom_message" && entry.customType === snapshots[0].customType)).toHaveLength(count);
			expect(flow.requests).toHaveLength(3);
			expect(flow.errors).toEqual([]);
		} finally { flow.close(); }
	});

	it.each(["threshold", "overflow"])("post-run %s compact: no extra run, refresh at next natural prompt", async (reason) => {
		const flow = await setup();
		try {
			flow.settingsManager.applyOverrides({ compaction: { enabled: true } });
			flow.respond(reason === "threshold" ? { high: true } : { overflow: true }, {});
			await flow.session.prompt("Run and compact");
			expect(flow.events).toContain(`compact:${reason}:${reason === "overflow"}`);
			expect(flow.requests).toHaveLength(reason === "threshold" ? 1 : 2);
			expect(flow.reminders()).toHaveLength(0);
			expect(flow.events.filter(event => event === "before_agent_start")).toHaveLength(1);
			writeFileSync(flow.planPath, plan("next-natural"));
			await flow.session.prompt("Next natural prompt");
			expect(flow.reminders()).toHaveLength(1);
			expect(flow.reminders()[0].content).toContain("fixture appendix next-natural");
			expect(flow.errors).toEqual([]);
		} finally { flow.close(); }
	});

	it("stale tool-loop reminder waits for a natural prompt and persists only the working set", async () => {
		const flow = await setup();
		try {
			flow.respond(...Array.from({ length: 8 }, () => ({ tool: true })), {});
			await flow.session.prompt("Long tool run");
			expect(flow.requests).toHaveLength(9);
			const count = () => flow.sm.getBranch().filter((entry: any) => entry.type === "custom_message" && entry.customType === "pi-goals-plan-reminder").length;
			expect(count()).toBe(1); // startup only; no turn_end/ephemeral reminders
			await flow.session.prompt("Natural prompt after staleness");
			expect(count()).toBe(2);
			const text = JSON.stringify(flow.requests.at(-1).at(-1));
			expect(text).toContain("test saved reminders");
			expect(text).not.toContain("fixture appendix");
			await flow.session.prompt("No duplicate");
			expect(count()).toBe(2);
			expect(flow.errors).toEqual([]);
		} finally { flow.close(); }
	});

	it.skipIf(Number(sdkVersion.split(".")[1]) < 85).each([false, true])("mid-run threshold, queued user=%s: defer without drops, duplicates, or extra response", async (queue) => {
		const flow = await setup();
		try {
			flow.settingsManager.applyOverrides({ compaction: { enabled: true } });
			flow.respond({ tool: true, high: true, queue }, {});
			await flow.session.prompt("Use fixture tool");
			expect(flow.events).toContain("compact:threshold:false");
			expect(flow.requests).toHaveLength(2);
			expect(JSON.stringify(flow.requests[1][0])).toContain("Offline checkpoint"); // compacted before the tool continuation, not just after the run
			expect(flow.events.filter(event => event === "before_agent_start")).toHaveLength(1);
			expect(flow.reminders()).toHaveLength(0);
			if (queue) expect(JSON.stringify(flow.requests[1].at(-1))).toContain("Queued user must retain order");
			writeFileSync(flow.planPath, plan("after-auto"));
			await flow.session.prompt("Next natural prompt");
			expect(flow.reminders()).toHaveLength(1);
			expect(flow.reminders()[0].content).toContain("fixture appendix after-auto");
			await flow.session.prompt("No duplicate");
			expect(flow.reminders()).toHaveLength(1);
			expect(flow.requests).toHaveLength(4);
			expect(flow.errors).toEqual([]);
		} finally { flow.close(); }
	});
});
