import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { backgroundState } from "../../src/internal/supervisor/background.js";
import extension from "../../src/internal/supervisor/index.js";
import { type SupervisorBinding as PlanBinding, planHash } from "../../src/supervisor.js";

const tick = () => new Promise(resolve => setImmediate(resolve));

test("bootstrap failure reaches only its matching attachment wait", async () => {
  const h = pairHarness();
  try {
    await h.worker.hook("session_start"); await h.supervisor.hook("session_start");
    await h.worker.controller.prepare(h.binding);
    const wait = h.worker.controller.attached(h.binding.id);
    let settled = false; void wait.then(() => { settled = true; }, () => { settled = true; });
    const rejection = assert.rejects(wait, /Native compaction timeout/);
    h.worker.receive({ type: "message", fromSessionId: "other", payload: { t: "plan_failed", to: "worker", bindingId: h.binding.id, sessionFile: "/wrong/session", reason: "wrong attempt" } });
    await tick(); assert.equal(settled, false);
    h.supervisor.ctx.compact = ({ onError }: any) => onError(new Error("Native compaction timeout"));
    await assert.rejects(h.supervisor.controller.bootstrap({ binding: h.binding, workerId: "worker" }), /Native compaction timeout/);
    await rejection;
    assert.match((await h.worker.controller.status()).lastFailure, /Native compaction timeout/);
    await assert.rejects(h.worker.controller.attached(h.binding.id), /Native compaction timeout/, "retry cannot hang on a known failed attachment");
  } finally { await h.close(); }
});

test("human pause survives reload/reconnect; only explicit resume reactivates the same pair", async () => {
  const h = pairHarness();
  try {
    await h.start();
    await h.worker.controller.activate(h.binding.id);
    await tick();
    h.worker.controller.pause(); await tick();
    assert.equal((await h.worker.controller.status()).binding.paused, true);
    assert.equal((await h.supervisor.controller.status()).binding.active, false);
    const reloaded = await h.restart(h.supervisor, "supervisor-reloaded");
    const views = h.wire.filter(w => w.t === "view").length;
    await h.worker.controller.reconnect(); await tick();
    assert.equal((await reloaded.controller.status()).binding.paused, true);
    assert.equal(h.wire.filter(w => w.t === "view").length, views);
    const pairs = h.wire.filter(w => w.t === "pair").length;
    await h.worker.controller.resume(h.binding.id, planHash(readFileSync(h.planPath, "utf8")));
    assert.equal((await reloaded.controller.status()).binding.paused, false);
    assert.equal((await h.worker.controller.status()).binding.active, true);
    assert.equal(h.wire.filter(w => w.t === "pair").length, pairs);
    const oldResume = h.wire.findLast(w => w.t === "plan_resume");
    h.worker.controller.pause(); await tick();
    reloaded.receive({ type: "message", fromSessionId: "worker", payload: oldResume }); await tick();
    assert.equal((await reloaded.controller.status()).binding.paused, true, "a delayed old resume cannot undo a newer stop");
  } finally { await h.close(); }
});

test("stop cancels an in-flight checkpoint even when the cancel notification cannot be sent", async () => {
  const h = pairHarness();
  try {
    await h.start();
    const review = h.worker.controller.review(h.binding.id, "first", planHash(readFileSync(h.planPath, "utf8")));
    const cancelled = assert.rejects(review, /Stopped/);
    await tick();
    h.worker.connected = false;
    h.worker.controller.pause();
    await cancelled;
    assert.equal((await h.worker.controller.status()).binding.paused, true);
  } finally { await h.close(); }
});

test("supervisor pause cancels checkpoint and a disconnected local stop still persists", async () => {
  const h = pairHarness();
  try {
    await h.start();
    const pending = h.worker.controller.review(h.binding.id, "first", planHash(readFileSync(h.planPath, "utf8")));
    const cancelled = assert.rejects(pending, /cancelled|Stopped/);
    await tick();
    h.supervisor.controller.pause(true); await tick(); await cancelled;
    assert.equal((await h.worker.controller.status()).binding.paused, true);
    h.worker.connected = false;
    assert.doesNotThrow(() => h.worker.controller.pause());
    assert.equal((await h.worker.controller.status()).activity, "stopped by user");
    await assert.rejects(h.worker.controller.resume(h.binding.id, planHash(readFileSync(h.planPath, "utf8"))), /Intercom/);
  } finally { await h.close(); }
});
function pairHarness() {
  const cwd = mkdtempSync(join(tmpdir(), "supervise-plan-"));
  const peers: any[] = [];
  const wire: any[] = [];
  const planPath = join(cwd, "plan.md");
  writeFileSync(planPath, '# Plan\n\nUser voice: render the literal "[x]"\n\n1. [ ] goal: first\n2. [ ] goal: second\n');
  const binding: PlanBinding = { id: "binding", planPath, workerSession: join(cwd, "worker.jsonl"), workerPane: "w1:p1", supervisorSession: join(cwd, "supervisor.jsonl"), supervisorPane: "w1:p2", everyTurns: 50, intervalMs: 3_600_000, compactTokens: 100_000 };
  function make(id: string, entries: any[] = [], sessionFile = join(cwd, `${id}.jsonl`)) {
    const hooks = new Map<string, any[]>(); const listeners = new Map<string, Set<any>>(); const tools = new Map<string, any>();
    const messages: any[] = []; const contexts: any[] = []; const commands = new Map<string, any>();
    let active: string[] = ["read", "grep", "bash", "edit", "write"];
    const peer: any = { id, messages, contexts, entries, tools, commands, modelReady: true, activeProcesses: 0, activeSubagents: 0, idle: true, connected: true, compactions: 0, tokens: 50_000, aborts: 0 };
    const bus = {
      on(name: string, handler: any) { const set = listeners.get(name) ?? new Set(); set.add(handler); listeners.set(name, set); return () => set.delete(handler); },
      emit(name: string, value: any) {
        if (name === "intercom:extension-register") {
          peer.receive = value.onEvent;
          value.onReady({ snapshot: () => ({ connected: peer.connected, supported: true }), listSessions: async () => { peer.beforeListSessions?.(); return peers.map(p => ({ id: p.id, pid: p === peer ? process.pid : process.pid + 1, cwd, model: "test" })); }, publish(payload: any) {
            peer.beforePublish?.(payload);
            wire.push({ from: peer.id, ...payload });
            for (const p of peers) queueMicrotask(() => p.receive?.({ type: "message", fromSessionId: peer.id, payload }));
          } }); return true;
        }
        if (name === "processes:request:list") value.reply(Array.from({ length: peer.activeProcesses }, () => ({ status: "running" })));
        if (name === "subagents:rpc:v1:request") bus.emit(`subagents:rpc:v1:reply:${value.requestId}`, { requestId: value.requestId, success: true, data: { fleet: { version: 1, totalActive: peer.activeSubagents } } });
        for (const handler of listeners.get(name) ?? []) handler(value);
      },
    };
    const pi: any = { events: bus, on(name: string, fn: any) { hooks.set(name, [...(hooks.get(name) ?? []), fn]); }, registerTool(tool: any) { tools.set(tool.name, tool); active.push(tool.name); }, registerCommand(name: string, command: any) { commands.set(name, command); }, appendEntry(customType: string, data: any) { entries.push({ type: "custom", customType, data }); }, getActiveTools: () => active, setActiveTools: (names: string[]) => { active = names; }, getAllTools: () => [...["read", "grep", "find", "ls"].map(name => ({ name, sourceInfo: { source: "builtin" } })), { name: "subagent" }], sendMessage: (message: any) => contexts.push(message), sendUserMessage: (text: string, options: any) => messages.push({ text, options }) };
    const ctx: any = { cwd, hasUI: true, model: { provider: "native", id: "test", contextWindow: 200_000 }, isIdle: () => peer.idle, abort: () => { peer.aborts++; }, getContextUsage: () => ({ tokens: peer.tokens }), compact({ onComplete }: any) { peer.compactions++; peer.tokens = 10_000; onComplete({}); }, ui: { notify() {}, setStatus() {}, theme: { fg: (_: any, text: string) => text } }, sessionManager: { getEntries: () => entries, getBranch: () => entries, getSessionFile: () => sessionFile } };
    peer.pi = pi; peer.ctx = ctx;
    peer.hook = async (name: string, event = {}) => { let result: any; for (const fn of hooks.get(name) ?? []) result = await fn(event, ctx) ?? result; return result; };
    peers.push(peer); const controller = extension(pi, () => peer.modelReady, (plan) => {
      const goals = plan.match(/^\d+\. \[[ x/]\] goal:/gm) ?? [];
      return { completion: { planHash: planHash(plan), total: goals.length, pending: goals.length - (peer.signedOffCount ?? 0), inconclusive: peer.inconclusiveCount ?? 0 }, summary: `Manual completion claims await CompleteGoal; ${peer.signedOffCount ?? 0} recorded sign-offs.` };
    });
    peer.controller = controller;
    peer.request = (method: string, p: any = {}) => {
      switch (method) {
        case "prepare": return controller.prepare(p.binding, p.signal);
        case "bootstrap": return controller.bootstrap(p, p.signal);
        case "status": return controller.status(p.signal);
        case "review": return controller.review(p.bindingId, p.goal, p.planHash, p.signal);
        case "stop": return controller.stop(p.bindingId);
        case "activate": return controller.activate(p.bindingId, p.signal);
        case "attached": return controller.attached(p.bindingId, p.signal);
        default: throw new Error("Unknown test operation");
      }
    };
    peer.finishAssessment = async () => {
      await tools.get("let_it_run").execute("assessed", { reason: "Inspection complete" }, undefined, undefined, ctx);
      await peer.hook("agent_settled");
    };
    peer.review = async (decision = "approve", reason = "Faithful to the plan") => {
      await peer.hook("context", { messages: contexts });
      const result = await tools.get("review_goal").execute("review", { decision, reason });
      await peer.hook("agent_settled");
      return result;
    };
    return peer;
  }
  const worker = make("worker"); const supervisor = make("supervisor");
  return { worker, supervisor, binding, wire, planPath, async restart(peer: any, id: string) { await peer.hook("session_shutdown"); peers.splice(peers.indexOf(peer), 1); const replacement = make(id, structuredClone(peer.entries), peer.ctx.sessionManager.getSessionFile()); await replacement.hook("session_start"); await tick(); return replacement; }, async start() { await worker.hook("session_start"); await supervisor.hook("session_start"); await worker.request("prepare", { binding }); const attached = worker.request("attached", { bindingId: binding.id }); void attached.catch(() => {}); await supervisor.request("bootstrap", { binding, workerId: "worker" }); await attached; }, async close() { for (const peer of peers) await peer.hook("session_shutdown"); rmSync(cwd, { recursive: true, force: true }); } };
}

for (const assessment of ["On course; the saved check is the next useful evidence.", "Which output format do you want?"]) test(`ordinary prose leaves future reviews live: ${assessment}`, async () => {
  const h = pairHarness(); try {
    await h.start(); await h.worker.controller.activate(h.binding.id); await tick();
    const before = h.supervisor.messages.length;
    const looks = h.wire.filter((w: any) => w.t === "look").length;
    await h.supervisor.hook("agent_end", { messages: [{ role: "assistant", stopReason: "stop", content: [{ type: "text", text: assessment }] }] });
    for (let i = 0; i < 3; i++) { await h.supervisor.hook("agent_settled"); await tick(); }
    assert.equal(h.supervisor.messages.length, before, "no immediate idle retry");
    assert.equal(h.wire.filter((w: any) => w.t === "look").length, looks);
    h.worker.entries.push({ type: "message", message: { role: "user", content: "Use the agreed text format. Pause deployment until I authorize it; continue independent checks." } });
    await h.supervisor.receive({ type: "message", fromSessionId: "worker", payload: { t: "view", to: "supervisor", bindingId: h.binding.id, view: "New worker direction and progress", stopped: true } });
    await tick();
    assert.equal(h.supervisor.messages.length, before + 1, "new worker progress is not discarded after prose or a real question");
    await h.supervisor.finishAssessment();
    await h.supervisor.commands.get("supervise").handler("look", h.supervisor.ctx); await tick();
    assert.match(h.supervisor.messages.at(-1).text, /Pause deployment until I authorize it/);
  } finally { await h.close(); }
});

test("manual last-goal ticks cannot end plan supervision before CompleteGoal", async () => {
  const h = pairHarness(); try {
    await h.start();
    writeFileSync(h.planPath, "# Plan\n1. [x] goal: first\n2. [x] goal: second\n");
    await h.worker.controller.activate(h.binding.id); await tick();
    await assert.rejects(h.supervisor.tools.get("done").execute("", { reason: "All boxes checked" }, undefined, undefined, h.supervisor.ctx), /sign.off|claim|Open plan goals/i);
    assert.equal((await h.worker.controller.status()).connected, true);
    assert.equal(h.wire.filter((w: any) => w.t === "done").length, 0);
  } finally { await h.close(); }
});

test("completion counts are plan-bound and distinguish inconclusive sign-off when ending supervision", async () => {
  const h = pairHarness(); try {
    await h.start();
    writeFileSync(h.planPath, "# Plan\n1. [x] goal: first\n2. [x] goal: second\n");
    h.worker.signedOffCount = 2; h.worker.inconclusiveCount = 1;
    await h.worker.controller.activate(h.binding.id); await tick();
    const plan = readFileSync(h.planPath, "utf8");
    writeFileSync(h.planPath, plan + "3. [x] goal: unreviewed addition\n");
    await assert.rejects(h.supervisor.tools.get("done").execute("", { reason: "Old counts said complete" }, undefined, undefined, h.supervisor.ctx), /fresh CompleteGoal tracking/);
    writeFileSync(h.planPath, plan);
    await h.supervisor.tools.get("done").execute("", { reason: "Conclusive first goal; second accepted inconclusive" }, undefined, undefined, h.supervisor.ctx);
    assert.ok(h.supervisor.contexts.some((m: any) => /accepted inconclusive.*not independently verified/.test(m.content)));
  } finally { await h.close(); }
});

test("each checkpoint freezes fresh worker evidence and direction without replacing a busy assessment", async () => {
  const h = pairHarness(); try {
    await h.start();
    h.worker.entries.push({ type: "message", message: { role: "user", content: "Pause CLI work until I authorize goal two." } });
    await h.worker.controller.activate(h.binding.id); await tick();
    const active = (await h.supervisor.tools.get("worker_view").execute()).content[0].text;
    const hash = planHash(readFileSync(h.planPath, "utf8"));
    for (const goal of ["first", "second"]) {
      const direction = `You are now authorized to implement ${goal}; preserve the converter tests.`;
      h.worker.entries.push({ type: "message", message: { role: "user", content: direction } });
      h.worker.entries.push({ type: "message", message: { role: "assistant", content: `Saved ${goal} test evidence` } });
      const pending = h.worker.controller.review(h.binding.id, goal, hash); void pending.catch(() => {}); await tick();
      const request = h.wire.filter((w: any) => w.t === "goal_review").at(-1);
      assert.equal(typeof request.view, "string");
      assert.ok(request.view.includes(direction));
      assert.match(request.view, new RegExp(`Saved ${goal} test evidence`));
      if (goal === "first") {
        assert.equal((await h.supervisor.tools.get("worker_view").execute()).content[0].text, active);
        h.worker.entries.push({ type: "message", message: { role: "user", content: "Direction after the snapshot was frozen" } });
        await h.supervisor.finishAssessment(); await tick();
      }
      assert.equal((await h.supervisor.tools.get("worker_view").execute()).content[0].text, request.view);
      assert.ok(h.supervisor.contexts.at(-1).content.includes(request.view), "snapshot is presented with its checkpoint, not just hidden in a tool");
      await h.supervisor.receive({ type: "message", fromSessionId: "worker", payload: { t: "view", to: "supervisor", bindingId: h.binding.id, view: "A later routine update", stopped: false } });
      assert.equal((await h.supervisor.tools.get("worker_view").execute()).content[0].text, request.view);
      const context = await h.supervisor.hook("context", { messages: h.supervisor.contexts });
      assert.ok(context.messages[0].content.includes(readFileSync(h.planPath, "utf8")), "canonical plan remains whole and separate");
      await h.supervisor.review(goal === "first" ? "needs_work" : "approve");
      assert.equal((await pending).goal, goal);
      assert.equal(Object.hasOwn(h.wire.filter((w: any) => w.t === "goal_decision").at(-1), "view"), false);
      await tick();
      // Drain any routine overview before the next explicit checkpoint.
      await h.supervisor.finishAssessment(); await tick();
    }
  } finally { await h.close(); }
});

for (const cancellation of ["abort", "stop", "reload", "plan change"] as const) test(`checkpoint snapshot building cannot publish after ${cancellation}`, async () => {
  const h = pairHarness(); try {
    await h.start();
    const emit = h.worker.pi.events.emit;
    let release!: () => void;
    h.worker.pi.events.emit = (name: string, value: any) => {
      if (name === "subagents:rpc:v1:request") { release = () => emit(name, value); return; }
      return emit(name, value);
    };
    const abort = new AbortController();
    const pending = h.worker.controller.review(h.binding.id, "first", planHash(readFileSync(h.planPath, "utf8")), abort.signal);
    const rejected = assert.rejects(pending, /cancelled|stopped|reloaded|ended|changed/i);
    await tick(); assert.equal(typeof release, "function", "snapshot consults tracked work before publishing");
    if (cancellation === "abort") abort.abort();
    if (cancellation === "stop") await h.worker.controller.stop(h.binding.id);
    if (cancellation === "reload") await h.worker.hook("session_shutdown");
    if (cancellation === "plan change") writeFileSync(h.planPath, "Changed plan while snapshot was being built");
    if (cancellation !== "plan change") await rejected; // cancellation is prompt, not blocked on a tracker
    release(); await rejected; await tick();
    assert.equal(h.wire.filter((w: any) => w.t === "goal_review").length, 0);
  } finally { await h.close(); }
});

test("checkpoint capture includes user direction arriving while tracked work is queried", async () => {
  const h = pairHarness(); try {
    await h.start();
    const emit = h.worker.pi.events.emit;
    let release!: () => void;
    h.worker.pi.events.emit = (name: string, value: any) => {
      if (name === "subagents:rpc:v1:request") { release = () => emit(name, value); return; }
      return emit(name, value);
    };
    const pending = h.worker.controller.review(h.binding.id, "second", planHash(readFileSync(h.planPath, "utf8"))); void pending.catch(() => {}); await tick();
    h.worker.entries.push({ type: "message", message: { role: "user", content: "Latest authorization arrived during the tracker query." } });
    release(); await tick();
    const request = h.wire.find((w: any) => w.t === "goal_review");
    assert.match(request.view, /Latest authorization arrived during the tracker query/);
    await h.supervisor.review(); assert.equal((await pending).decision, "approve");
  } finally { await h.close(); }
});

test("checkpoint payload fits the serialized channel limit without truncating its identity", async () => {
  const h = pairHarness(); try {
    await h.start();
    h.worker.entries.push({ type: "message", message: { role: "user", content: "Latest authorization: implement goal two." } });
    for (let n = 0; n < 100; n++) h.worker.entries.push({ type: "message", message: { role: "assistant", content: `Evidence ${n}: ${'\\"'.repeat(200)}` } });
    const goal = `second ${"g".repeat(10_000)}`;
    const pending = h.worker.controller.review(h.binding.id, goal, planHash(readFileSync(h.planPath, "utf8")));
    void pending.catch(() => {}); await tick();
    const request = h.wire.filter((w: any) => w.t === "goal_review").at(-1);
    const { from: _from, ...payload } = request;
    assert.equal(request.goal, goal);
    assert.ok(Buffer.byteLength(JSON.stringify(payload)) <= 16 * 1024);
    assert.match(request.view, /Latest authorization: implement goal two/);
    assert.match(request.view, /cut|truncated/);
    await h.supervisor.review(); assert.equal((await pending).decision, "approve");
    await assert.rejects(h.worker.controller.review(h.binding.id, "x".repeat(17_000), request.planHash), /channel|16 KiB|too large/i);
    assert.equal(h.wire.filter((w: any) => w.t === "goal_review").length, 1, "oversized identity fails locally, not a silent broker drop");
  } finally { await h.close(); }
});

for (const content of [[], [{ type: "text", text: "" }], [{ type: "text", text: " \n " }], [{ type: "thinking", thinking: "Synthetic private block" }]]) test(`settled empty final response fails the checkpoint explicitly (${JSON.stringify(content.map(b => b.type))})`, async () => {
  const h = pairHarness(); try {
    await h.start(); const notices: string[] = [];
    h.supervisor.ctx.ui.notify = (message: string) => notices.push(message);
    const pending = h.worker.controller.review(h.binding.id, "first", planHash(readFileSync(h.planPath, "utf8"))); void pending.catch(() => {}); await tick();
    await h.supervisor.hook("agent_end", { messages: [{ role: "assistant", stopReason: "stop", content }] });
    assert.equal(h.wire.filter((w: any) => w.t === "goal_decision").length, 0, "agent_end alone cannot rule out native continuation");
    await h.supervisor.hook("agent_settled"); await tick();
    const decision = h.wire.find((w: any) => w.t === "goal_decision");
    assert.equal(decision?.decision, "needs_work", "empty final cannot leave the worker pending");
    assert.match((await pending).reason, /empty|incomplete/i);
    assert.ok(notices.some(notice => /empty|incomplete/i.test(notice)));
    assert.equal(Object.hasOwn(decision, "view"), false);
    assert.equal(h.wire.filter((w: any) => w.t === "pair").length, 1);
  } finally { await h.close(); }
});

for (const stopReason of ["stop", "error"]) test(`failed assessment resumes on later worker progress without a human poke (${stopReason})`, async () => {
  const h = pairHarness(); try {
    await h.start(); await h.worker.controller.activate(h.binding.id); await tick();
    const view = (text: string) => ({ type: "message", fromSessionId: "worker", payload: { t: "view", to: "supervisor", bindingId: h.binding.id, view: text, stopped: false } });
    await h.supervisor.receive(view("Progress while the assessment is busy")); await tick();
    const messages = h.supervisor.messages.length;
    const looks = h.wire.filter((w: any) => w.t === "look").length;
    await h.supervisor.hook("agent_end", { messages: [{ role: "assistant", stopReason, content: [] }] });
    for (let n = 0; n < 3; n++) { await h.supervisor.hook("agent_settled"); await tick(); }
    assert.equal(h.supervisor.messages.length, messages, "failure must not start a same-input retry loop");
    assert.equal(h.wire.filter((w: any) => w.t === "look").length, looks);
    await h.supervisor.receive(view("New worker progress after the failure")); await tick();
    assert.equal(h.supervisor.messages.length, messages + 1, "ordinary worker progress must resume supervision without user input");
    assert.match(h.supervisor.messages.at(-1)!.text, /New worker progress after the failure/);
  } finally { await h.close(); }
});

test("empty low-level response may continue through compaction, ask a human, or finish with a tool verdict", async () => {
  const h = pairHarness(); try {
    await h.start();
    const pending = h.worker.controller.review(h.binding.id, "first", planHash(readFileSync(h.planPath, "utf8"))); void pending.catch(() => {}); await tick();
    const empty = { messages: [{ role: "assistant", stopReason: "stop", content: [{ type: "text", text: "" }] }] };
    await h.supervisor.hook("agent_end", empty);
    await h.supervisor.hook("session_compact", { willRetry: true });
    assert.equal(h.wire.filter((w: any) => w.t === "goal_decision").length, 0);
    await h.supervisor.hook("agent_end", { messages: [{ role: "assistant", stopReason: "stop", content: [{ type: "text", text: "Should we keep the output format?" }] }] });
    await h.supervisor.hook("agent_settled"); await tick();
    assert.equal((await pending).decision, "needs_work", "prose alone cannot leave a checkpoint pending indefinitely");
    const retry = h.worker.controller.review(h.binding.id, "first", planHash(readFileSync(h.planPath, "utf8"))); await tick();
    await h.supervisor.hook("context", { messages: h.supervisor.contexts });
    await h.supervisor.tools.get("review_goal").execute("approved", { decision: "approve", reason: "The user confirmed the format" });
    await h.supervisor.hook("agent_end", empty);
    await h.supervisor.hook("agent_settled"); await tick();
    assert.equal((await retry).decision, "approve");
    assert.equal(h.wire.filter((w: any) => w.t === "goal_decision").length, 2);
  } finally { await h.close(); }
});

test("a successful goal tool verdict is not undone by an empty final response", async () => {
  const h = pairHarness(); try {
    await h.start(); const notices: string[] = [];
    h.supervisor.ctx.ui.notify = (message: string) => notices.push(message);
    const pending = h.worker.controller.review(h.binding.id, "first", planHash(readFileSync(h.planPath, "utf8"))); void pending.catch(() => {}); await tick();
    await h.supervisor.hook("context", { messages: h.supervisor.contexts });
    await h.supervisor.tools.get("review_goal").execute("approved", { decision: "approve", reason: "Evidence matches scope" });
    await h.supervisor.hook("agent_end", { messages: [{ role: "assistant", stopReason: "stop", content: [] }] });
    await h.supervisor.hook("agent_settled"); await tick();
    assert.equal((await pending).decision, "approve");
    assert.equal(h.wire.filter((w: any) => w.t === "goal_decision").length, 1);
    assert.equal(notices.some(notice => /incomplete|waiting for user/i.test(notice)), false);
  } finally { await h.close(); }
});

test("a duplicate checkpoint rejection never echoes its snapshot or changes the active view", async () => {
  const h = pairHarness(); try {
    await h.start();
    const pending = h.worker.controller.review(h.binding.id, "first", planHash(readFileSync(h.planPath, "utf8"))); void pending.catch(() => {}); await tick();
    const request = h.wire.find((w: any) => w.t === "goal_review");
    const view = (await h.supervisor.tools.get("worker_view").execute()).content[0].text;
    await h.supervisor.receive({ type: "message", fromSessionId: "worker", payload: { ...request, requestId: "duplicate", view: "Do not replace the active view" } });
    await tick();
    const rejected = h.wire.find((w: any) => w.t === "goal_decision");
    assert.equal(rejected.requestId, "duplicate");
    assert.equal(Object.hasOwn(rejected, "view"), false);
    assert.equal((await h.supervisor.tools.get("worker_view").execute()).content[0].text, view);
    await h.supervisor.review(); assert.equal((await pending).decision, "approve");
  } finally { await h.close(); }
});

test("an empty routine assessment cannot fail a separately queued checkpoint", async () => {
  const h = pairHarness(); try {
    await h.start(); await h.worker.controller.activate(h.binding.id); await tick();
    const pending = h.worker.controller.review(h.binding.id, "first", planHash(readFileSync(h.planPath, "utf8"))); void pending.catch(() => {}); await tick();
    await h.supervisor.hook("agent_end", { messages: [{ role: "assistant", stopReason: "stop", content: [] }] });
    await h.supervisor.hook("agent_settled"); await tick();
    assert.equal(h.wire.filter((w: any) => w.t === "goal_decision").length, 0);
    assert.equal(h.supervisor.contexts.filter((m: any) => m.customType === "supervisor_checkpoint").length, 1);
    await h.supervisor.review(); assert.equal((await pending).decision, "approve");
  } finally { await h.close(); }
});

test("plan bootstrap compacts only the supervisor and pairing alone never starts a worker or a review", async () => {
  const h = pairHarness(); try {
    await h.start(); assert.equal(h.worker.compactions, 0); assert.equal(h.supervisor.compactions, 1);
    assert.equal(h.worker.messages.length, 0); assert.equal(h.supervisor.messages.length, 0);
    assert.ok(h.supervisor.contexts.some((m: any) => m.content.includes('literal "[x]"')));
    await h.worker.request("activate", { bindingId: h.binding.id }); await tick();
    assert.equal(h.supervisor.messages.length, 1); assert.match(h.supervisor.messages[0].text, /still going/);
    assert.equal(h.worker.messages.length, 0);
  } finally { await h.close(); }
});

test("goal decisions are correlated, preserve the pair across two goals, and cannot call overall done", async () => {
  const h = pairHarness(); try {
    await h.start(); const hash = planHash(readFileSync(h.planPath, "utf8"));
    for (const goal of ["first", "second"]) {
      const result = h.worker.request("review", { bindingId: h.binding.id, goal, planHash: hash }); await tick();

      await assert.rejects(h.supervisor.tools.get("done").execute("", { reason: "done" }, undefined, undefined, h.supervisor.ctx), /Open plan goals/);
      await assert.rejects(h.supervisor.tools.get("review_goal").execute("", { decision: "approve", reason: "Not presented yet" }), /No matching/);
      await h.supervisor.review();
      assert.equal((await result).goal, goal); assert.equal((await h.worker.request("status")).connected, true);
    }
    assert.equal(h.wire.filter((w: any) => w.t === "done").length, 0);
  } finally { await h.close(); }
});

test("abort and stop cancel pending requests; late decisions cannot approve a replacement", async () => {
  const h = pairHarness(); try {
    await h.start(); const abort = new AbortController();
    const pending = h.worker.request("review", { bindingId: h.binding.id, goal: "first", planHash: planHash(readFileSync(h.planPath, "utf8")), signal: abort.signal });
    const rejected = assert.rejects(pending, /cancelled/); await tick(); abort.abort(); await rejected; await tick();
    assert.equal(h.supervisor.aborts, 1);
    await h.worker.request("stop", { bindingId: h.binding.id }); await tick(); assert.equal((await h.worker.request("status")).connected, false);
  } finally { await h.close(); }
});

test("50 actual model turns trigger one view, independent of the number of messages", async () => {
  const h = pairHarness(); try {
    await h.start(); await h.worker.request("activate", { bindingId: h.binding.id }); await tick(); h.worker.idle = false;
    const count = h.wire.filter((w: any) => w.t === "view").length;
    for (let n = 0; n < 49; n++) await h.worker.hook("turn_end");
    assert.equal(h.wire.filter((w: any) => w.t === "view").length, count);
    await h.worker.hook("turn_end"); await tick();
    assert.equal(h.wire.filter((w: any) => w.t === "view").length, count + 1);
  } finally { await h.close(); }
});

test("unknown background providers are not proof of quiescence", async () => {
  const result = await backgroundState({ events: { emit() {} }, getAllTools: () => [{ name: "process" }] });
  assert.equal(result.quiet, false); assert.match(result.description, /unknown/);
});

test("stale plan content invalidates a pending goal review", async () => {
  const h = pairHarness(); try {
    await h.start(); const abort = new AbortController();
    const pending = h.worker.request("review", { bindingId: h.binding.id, goal: "first", planHash: planHash(readFileSync(h.planPath, "utf8")), signal: abort.signal });
    const rejected = assert.rejects(pending, /Plan changed/); await tick();
    writeFileSync(h.planPath, "Human changed the requirement");
    await assert.rejects(h.supervisor.review(), /Plan changed/);
    abort.abort(); await rejected;
  } finally { await h.close(); }
});


test("small forks skip compaction, but real compaction failure prevents pairing", async () => {
  const small = pairHarness(); try {
    small.supervisor.tokens = 10_000; await small.start(); assert.equal(small.supervisor.compactions, 0);
    assert.ok(small.supervisor.contexts.some((m: any) => m.content.includes('literal "[x]"')));
  } finally { await small.close(); }
  const failed = pairHarness(); try {
    failed.supervisor.ctx.compact = ({ onError }: any) => onError(new Error("Compaction provider failed"));
    await assert.rejects(failed.start(), /Compaction provider failed/);
    assert.equal(failed.wire.filter((w: any) => w.t === "pair").length, 0);
  } finally { await failed.close(); }
});

for (const tokens of [50_000, null]) test(`native small-history result permits startup after an attempted compaction (${tokens})`, async () => {
  const h = pairHarness(); const notices: string[] = [];
  try {
    h.supervisor.tokens = tokens;
    h.supervisor.ctx.ui.notify = (message: string) => notices.push(message);
    h.supervisor.ctx.compact = ({ onError }: any) => {
      h.supervisor.compactions++;
      onError(new Error("Nothing to compact (session too small)"));
    };
    await h.start();
    assert.equal(h.supervisor.compactions, 1, "unknown or larger context must still attempt native compaction");
    assert.equal(h.worker.compactions, 0);
    assert.equal((await h.worker.request("status")).connected, true);
    assert.equal(h.worker.messages.length, 0, "pairing does not start work before activation");
    assert.ok(notices.some(message => /no older history eligible/i.test(message)));
    assert.ok(h.supervisor.contexts.some((message: any) => message.content.includes('literal "[x]"')));
  } finally { await h.close(); }
});

test("the hour timer and a coincident turn checkpoint produce a single view", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setInterval", "setTimeout"] });
  const h = pairHarness(); try {
    await h.start(); await h.worker.request("activate", { bindingId: h.binding.id }); await tick(); h.worker.idle = false;
    const count = h.wire.filter((w: any) => w.t === "view").length;
    for (let n = 0; n < 49; n++) await h.worker.hook("turn_end");
    t.mock.timers.tick(3_600_000); await h.worker.hook("turn_end"); await tick();
    assert.equal(h.wire.filter((w: any) => w.t === "view").length, count + 1);
  } finally { await h.close(); t.mock.timers.reset(); }
});

test("settled checks wait for tracked processes and subagents to finish", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setInterval", "setTimeout"] });
  const h = pairHarness(); try {
    await h.start(); await h.worker.request("activate", { bindingId: h.binding.id }); await tick();
    t.mock.timers.tick(2_000); h.worker.activeProcesses = 1; h.worker.activeSubagents = 1;
    const count = h.wire.filter((w: any) => w.t === "view").length;
    await h.worker.hook("agent_settled"); await tick();
    assert.equal(h.wire.filter((w: any) => w.t === "view").length, count);
    h.worker.activeProcesses = 0; h.worker.pi.events.emit("processes:ended", {}); await tick();
    assert.equal(h.wire.filter((w: any) => w.t === "view").length, count);
    h.worker.activeSubagents = 0; h.worker.pi.events.emit("subagent:async-complete", {}); await tick();
    assert.equal(h.wire.filter((w: any) => w.t === "view").length, count + 1);
  } finally { await h.close(); t.mock.timers.reset(); }
});

test("bootstrap stop cannot resurrect a supervisor after compaction completes", async () => {
  const h = pairHarness(); let finish!: () => void;
  h.supervisor.ctx.compact = ({ onComplete }: any) => { finish = onComplete; };
  try {
    const starting = h.start(); const rejected = assert.rejects(starting, /cancelled/); await tick();
    await h.worker.request("stop", { bindingId: h.binding.id }); await tick(); finish(); await rejected;
    assert.equal(h.wire.filter((w: any) => w.t === "pair").length, 0);
    const restarted = await h.restart(h.supervisor, "stopped-bootstrap-reloaded");
    await assert.rejects(restarted.request("bootstrap", { binding: h.binding, workerId: "worker" }), /was stopped/);
    assert.equal(restarted.compactions, 0);
    assert.equal(h.wire.filter((w: any) => w.t === "pair").length, 0);
    assert.equal((await restarted.request("status")).binding.stopped, true);
  } finally { await h.close(); }
});


test("a restarted worker reconnects by exact saved session identity without a new supervisor", async () => {
  const h = pairHarness(); try {
    await h.start(); await h.worker.request("activate", { bindingId: h.binding.id }); await tick();
    const reloaded = await h.restart(h.worker, "worker-after-restart");
    assert.equal((await reloaded.request("status")).connected, true);
    assert.equal(h.wire.filter((w: any) => w.t === "pair").length, 1);
    assert.equal(h.supervisor.compactions, 1);
    await h.supervisor.finishAssessment();
    const pending = reloaded.request("review", { bindingId: h.binding.id, goal: "first", planHash: planHash(readFileSync(h.planPath, "utf8")) }); await tick();

    await h.supervisor.review();
    assert.equal((await pending).decision, "approve");
  } finally { await h.close(); }
});

test("unknown initial context must compact instead of taking the known-small shortcut", async () => {
  const h = pairHarness(); try {
    h.supervisor.tokens = null;
    await h.start();
    assert.equal(h.supervisor.compactions, 1);
  } finally { await h.close(); }
});

test("null post-compaction usage cannot raise the next configured 100k checkpoint", async () => {
  const h = pairHarness(); try {
    h.supervisor.tokens = 150_000;
    h.supervisor.ctx.compact = ({ onComplete }: any) => {
      h.supervisor.compactions++;
      h.supervisor.tokens = null; // Native Pi has no assistant usage yet after compaction.
      onComplete({ estimatedTokensAfter: 10_000 });
    };
    await h.start();
    await h.worker.request("activate", { bindingId: h.binding.id }); await tick();
    assert.equal(h.supervisor.compactions, 1);
    await h.supervisor.finishAssessment();
    h.supervisor.tokens = 100_001;
    await h.supervisor.receive({ type: "message", fromSessionId: "worker", payload: { t: "view", to: "supervisor", bindingId: h.binding.id, view: "New work since compaction", stopped: false } });
    await tick();
    assert.equal(h.supervisor.compactions, 2);
  } finally { await h.close(); }
});

test("stopping a routine view during compaction invalidates its suspended continuation", async () => {
  const h = pairHarness(); let finish!: () => void;
  try {
    await h.start(); await h.worker.request("activate", { bindingId: h.binding.id }); await tick();
    await h.supervisor.finishAssessment();
    h.supervisor.tokens = 150_000;
    h.supervisor.ctx.compact = ({ onComplete }: any) => { finish = onComplete; };
    h.supervisor.receive({ type: "message", fromSessionId: "worker", payload: { t: "view", to: "supervisor", bindingId: h.binding.id, view: "Must not restart the stopped supervisor", stopped: false } });
    await tick(); assert.equal(typeof finish, "function");
    await h.worker.request("stop", { bindingId: h.binding.id }); await tick();
    const messages = h.supervisor.messages.length;
    const contexts = h.supervisor.contexts.length;
    const entries = h.supervisor.entries.length;
    finish(); await tick();
    assert.equal(h.supervisor.messages.length, messages);
    assert.equal(h.supervisor.contexts.length, contexts);
    assert.equal(h.supervisor.entries.length, entries);
    assert.equal((await h.supervisor.request("status")).binding.stopped, true);
  } finally { await h.close(); }
});

test("restart of a provisional bootstrap resumes compaction and pairing in the same saved session", async () => {
  const h = pairHarness(); let finish!: () => void;
  try {
    await h.worker.hook("session_start"); await h.supervisor.hook("session_start");
    await h.worker.request("prepare", { binding: h.binding });
    const attached = h.worker.request("attached", { bindingId: h.binding.id });
    void attached.catch(() => {});
    h.supervisor.ctx.compact = ({ onComplete }: any) => { finish = onComplete; };
    const interrupted = h.supervisor.request("bootstrap", { binding: h.binding, workerId: "worker" });
    const rejected = assert.rejects(interrupted, /cancelled/); await tick();
    assert.equal(h.supervisor.entries.at(-1).data.role, "supervisor");
    assert.notEqual(h.supervisor.entries.at(-1).data.planInitialized, true);
    const restarted = await h.restart(h.supervisor, "supervisor-restarted");
    finish(); await rejected;
    assert.equal(h.wire.filter((w: any) => w.t === "look" || w.t === "plan_hello").length, 0);
    await restarted.request("bootstrap", { binding: h.binding, workerId: "worker" });
    const ready = await attached;
    assert.equal(ready.supervisorSession, h.binding.supervisorSession);
    assert.equal(restarted.ctx.sessionManager.getSessionFile(), h.binding.supervisorSession);
    assert.equal(restarted.compactions, 1);
    assert.equal(restarted.entries.at(-1).data.planInitialized, true);
    assert.equal((await h.worker.request("status")).connected, true);
    assert.equal(h.wire.filter((w: any) => w.t === "pair").length, 1);
    // An acknowledged reload reuses the pairing rather than bootstrapping once again.
    const acknowledged = await h.restart(restarted, "supervisor-acknowledged-reloaded");
    await acknowledged.request("bootstrap", { binding: h.binding, workerId: "worker" });
    assert.equal(acknowledged.compactions, 0);
    assert.equal(h.wire.filter((w: any) => w.t === "pair").length, 1);
  } finally { await h.close(); }
});

for (const stop of ["command", "done"]) test(`${stop} preserves a stopped supervisor across reload`, async () => {
  const h = pairHarness(); try {
    await h.start();
    if (stop === "command") await h.supervisor.commands.get("supervise").handler("stop", h.supervisor.ctx);
    else {
      writeFileSync(h.planPath, "# Plan\n\n1. [x] goal: first\n2. [x] goal: second\n");
      h.worker.signedOffCount = 2;
      await h.worker.request("activate", { bindingId: h.binding.id }); await tick();
      await h.supervisor.tools.get("done").execute("", { reason: "All goals accepted" }, undefined, undefined, h.supervisor.ctx);
    }
    await tick(); const pairCount = h.wire.filter((w: any) => w.t === "pair").length;
    const restarted = await h.restart(h.supervisor, `${stop}-reloaded`);
    await assert.rejects(restarted.request("bootstrap", { binding: h.binding, workerId: "worker" }), /was stopped/);
    assert.equal(restarted.compactions, 0);
    assert.equal(h.wire.filter((w: any) => w.t === "pair").length, pairCount);
    assert.equal((await restarted.request("status")).binding.stopped, true);
  } finally { await h.close(); }
});

test("same-binding replay retains activation when the supervisor lost its acknowledgement", async () => {
  const h = pairHarness(); try {
    await h.worker.hook("session_start"); await h.supervisor.hook("session_start");
    await h.worker.request("prepare", { binding: h.binding });
    const attached = h.worker.request("attached", { bindingId: h.binding.id });
    // Simulate loss of the supervisor before it receives/persists the acknowledgement.
    // The worker still receives pair and can finish Ready independently of that process.
    h.supervisor.receive = () => {};
    void h.supervisor.request("bootstrap", { binding: h.binding, workerId: "worker" }).catch(() => {});
    await attached;
    await h.worker.request("activate", { bindingId: h.binding.id }); await tick();
    assert.equal((await h.worker.request("status")).binding.active, true);
    assert.notEqual(h.supervisor.entries.at(-1).data.planInitialized, true);
    assert.notEqual(h.supervisor.entries.at(-1).data.plan.active, true);

    const restarted = await h.restart(h.supervisor, "supervisor-after-lost-ack");
    await restarted.request("bootstrap", { binding: h.binding, workerId: "worker" });
    assert.equal(restarted.ctx.sessionManager.getSessionFile(), h.binding.supervisorSession);
    assert.equal((await h.worker.request("status")).binding.active, true);
    assert.equal(h.wire.findLast((w: any) => w.t === "paired").plan.active, true);
    assert.equal((await restarted.request("status")).binding.active, true);
    assert.equal(restarted.entries.at(-1).data.planInitialized, true);

    const views = h.wire.filter((w: any) => w.t === "view").length;
    const messages = restarted.messages.length;
    h.worker.idle = false;
    for (let n = 0; n < 50; n++) await h.worker.hook("turn_end");
    await tick();
    assert.equal(h.wire.filter((w: any) => w.t === "view").length, views + 1);
    assert.equal(restarted.messages.length, messages + 1);
    assert.equal(h.wire.filter((w: any) => w.t === "plan_activate").length, 1);
    assert.equal(h.worker.messages.length, 0); // No new Ready/work handoff was necessary.
  } finally { await h.close(); }
});


test("model-unavailable stop validates binding, cancels pending reviews and ignores old directives", async () => {
  const h = pairHarness(); try {
    await h.start(); await h.worker.request("activate", { bindingId: h.binding.id }); await tick();
    const abort = new AbortController();
    const pending = h.worker.request("review", { bindingId: h.binding.id, goal: "first", planHash: planHash(readFileSync(h.planPath, "utf8")), signal: abort.signal });
    const cancelled = assert.rejects(pending, /cancelled/); await tick();
    h.worker.modelReady = false; abort.abort(); await cancelled; await tick();
    await assert.rejects(h.worker.request("stop", { bindingId: "wrong-binding" }), /No matching plan pairing/);
    await h.worker.request("stop", { bindingId: h.binding.id }); await tick();
    assert.equal(h.worker.entries.at(-1).data.role, "none");
    assert.equal(h.supervisor.entries.at(-1).data.role, "none");
    const before = h.worker.messages.length;
    h.worker.modelReady = true;
    h.worker.receive({ type: "message", fromSessionId: "supervisor", payload: { t: "directive", to: "worker", text: "stale instruction" } });
    await tick(); assert.equal(h.worker.messages.length, before);
  } finally { await h.close(); }
});

test("supervisor mode is a native inspection allowlist at visibility and execution, including reload and stopped forks", async () => {
  const h = pairHarness(); try {
    const mutations = ["bash", "write", "edit", "process", "subagent", "schedule", "intercom", "mcp_execute", "search_tools", "unknown_tool"];
    h.supervisor.pi.setActiveTools([...h.supervisor.pi.getActiveTools(), ...mutations]);
    await h.start();
    for (const toolName of mutations) {
      assert.ok(!h.supervisor.pi.getActiveTools().includes(toolName), toolName);
      h.supervisor.pi.setActiveTools([...h.supervisor.pi.getActiveTools(), toolName]);
      const blocked = await h.supervisor.hook("tool_call", { toolName, input: {} });
      assert.equal(blocked?.block, true, `${toolName} must be blocked even if re-enabled by another extension`);
    }
    assert.equal((await h.supervisor.hook("tool_call", { toolName: "read", input: {} }))?.block, undefined);
    const nativeTools = h.supervisor.pi.getAllTools;
    h.supervisor.pi.getAllTools = () => [{ name: "read", sourceInfo: { source: "extension" } }];
    assert.equal((await h.supervisor.hook("tool_call", { toolName: "read", input: {} }))?.block, true, "a custom override is not a native reader");
    h.supervisor.pi.getAllTools = nativeTools;
    const reloaded = await h.restart(h.supervisor, "supervisor-reloaded");
    assert.equal((await reloaded.hook("tool_call", { toolName: "subagent", input: {} }))?.block, true);
    assert.equal((await reloaded.hook("user_bash", { command: "touch never" }))?.result.exitCode, 1);
    await h.worker.request("stop", { bindingId: h.binding.id }); await tick();
    assert.equal((await reloaded.hook("tool_call", { toolName: "write", input: {} }))?.block, true);
  } finally { await h.close(); }
});

test("a cancelled checkpoint's delayed verdict cannot approve the replacement checkpoint", async () => {
  const h = pairHarness(); try {
    await h.start();
    const hash = planHash(readFileSync(h.planPath, "utf8"));
    const abort = new AbortController();
    const old = h.worker.controller.review(h.binding.id, "first", hash, abort.signal);
    const cancelled = assert.rejects(old, /cancelled/); await tick();
    await h.supervisor.hook("context", { messages: [...h.supervisor.contexts] });
    abort.abort(); await cancelled; await tick();
    await h.supervisor.hook("agent_settled");
    const next = h.worker.controller.review(h.binding.id, "second", hash); await tick();
    await assert.rejects(h.supervisor.tools.get("review_goal").execute("late", { decision: "approve", reason: "Old assessment" }), /No matching/);
    await h.supervisor.review();
    assert.equal((await next).goal, "second");
    assert.equal(h.wire.filter((w: any) => w.t === "goal_decision").length, 1);
  } finally { await h.close(); }
});

test("each model call reanchors the canonical plan and role without losing compacted planning context or judgments", async () => {
  const h = pairHarness(); try {
    await h.start();
    const history = [{ role: "compactionSummary", summary: "User requires literal [x]; avoid global changes" }, { role: "assistant", content: [{ type: "text", text: "Earlier judgment: test boundary conditions" }] }];
    writeFileSync(h.planPath, "# Current plan\n1. [/] goal: first\nEvidence: new receipt");
    const result = await h.supervisor.hook("context", { messages: history });
    assert.match(result.messages[0].content, /You are the supervisor, not the worker/);
    assert.match(result.messages[0].content, /Evidence: new receipt/);
    assert.deepEqual(result.messages.slice(1), history);
  } finally { await h.close(); }
});

test("routine assessments and steering display the actual advice rather than only a receipt", async () => {
  const h = pairHarness(); try {
    await h.start(); await h.worker.controller.activate(h.binding.id); await tick();
    await h.supervisor.tools.get("let_it_run").execute("look", { reason: "Parser tests now pass; keep the remaining change focused on recovery." }, undefined, undefined, h.supervisor.ctx);
    await h.supervisor.tools.get("steer").execute("steer", { message: "Check reload before claiming completion; the previous view has no restart evidence." }, undefined, undefined, h.supervisor.ctx);
    assert.ok(h.supervisor.contexts.some((m: any) => m.display && m.content.includes("Parser tests now pass")));
    assert.ok(h.supervisor.contexts.some((m: any) => m.display && m.content.includes("Check reload before claiming completion")));
    await tick(); assert.match(h.worker.messages.at(-1).text, /Check reload before claiming completion/);
  } finally { await h.close(); }
});

test("current context above 100k compacts; cumulative usage and exactly 100k do not", async () => {
  const h = pairHarness(); try {
    await h.start(); await h.worker.controller.activate(h.binding.id); await tick();
    await h.supervisor.finishAssessment();
    h.supervisor.entries.push({ type: "message", message: { role: "assistant", usage: { totalTokens: 900_000 } } });
    const view = () => h.supervisor.receive({ type: "message", fromSessionId: "worker", payload: { t: "view", to: "supervisor", bindingId: h.binding.id, view: "Current progress", stopped: false } });
    h.supervisor.tokens = 100_000; view(); await tick(); assert.equal(h.supervisor.compactions, 1);
    await h.supervisor.finishAssessment();
    h.supervisor.tokens = 100_001; view(); await tick(); assert.equal(h.supervisor.compactions, 2);
  } finally { await h.close(); }
});

test("absent optional trackers count as zero tracked work; installed failed or busy trackers remain non-quiet", async () => {
  assert.equal((await backgroundState({ events: { emit() {} }, getAllTools: () => [] })).quiet, true);
  for (const rows of [undefined, [{ status: "running" }], [{ status: "unexpected" }]]) {
    const status = await backgroundState({ events: { emit(_name: string, request: any) { if (rows) request.reply(rows); } }, getAllTools: () => [{ name: "process" }] });
    assert.equal(status.quiet, false);
  }
});

test("a settled worker with no optional trackers sends one review, not repeated idle wakes", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setInterval", "setTimeout"] });
  const h = pairHarness(); try {
    h.worker.pi.getAllTools = () => [];
    await h.start(); await h.worker.controller.activate(h.binding.id); await tick();
    const count = h.wire.filter((w: any) => w.t === "view").length;
    t.mock.timers.tick(2_000); await h.worker.hook("agent_settled"); await tick();
    assert.equal(h.wire.filter((w: any) => w.t === "view").length, count + 1);
    t.mock.timers.tick(30_000); await tick();
    assert.equal(h.wire.filter((w: any) => w.t === "view").length, count + 1);
  } finally { await h.close(); t.mock.timers.reset(); }
});

test("disconnect cancels a checkpoint and blocks steering; local stop still clears ownership", async () => {
  const h = pairHarness(); try {
    await h.start(); await h.worker.controller.activate(h.binding.id); await tick();
    const pending = h.worker.controller.review(h.binding.id, "first", planHash(readFileSync(h.planPath, "utf8")));
    const rejected = assert.rejects(pending, /disconnected/); await tick();
    h.worker.connected = false;
    h.worker.receive({ type: "connection", connected: false, supported: true }); await rejected;
    h.supervisor.receive({ type: "session_left", sessionId: "worker" }); await tick();
    await assert.rejects(h.supervisor.tools.get("steer").execute("steer", { message: "Do not claim delivery" }, undefined, undefined, h.supervisor.ctx), /Worker disconnected/);
    await assert.rejects(h.worker.controller.stop(h.binding.id), /Stopped locally/);
    assert.equal(h.worker.entries.at(-1).data.role, "none");
  } finally { await h.close(); }
});

test("registered malformed subagent tracker stays unknown even when the process tracker is absent", async () => {
  let reply: (value: any) => void = () => {};
  const result = await backgroundState({
    getAllTools: () => [{ name: "subagent" }],
    events: { on(_event: string, fn: any) { reply = fn; return () => {}; }, emit(event: string, value: any) { if (event === "subagents:rpc:v1:request") reply({ requestId: value.requestId, success: true, data: { fleet: { version: 1, totalActive: "not a count" } } }); } },
  });
  assert.equal(result.quiet, false);
  assert.match(result.description, /processes: 0; subagents: unknown/);
});

test("a busy supervisor defers the 100k compaction until its own run settles", async () => {
  const h = pairHarness(); try {
    await h.start(); await h.worker.controller.activate(h.binding.id); await tick();
    h.supervisor.tokens = 100_001; h.supervisor.idle = false;
    h.supervisor.receive({ type: "message", fromSessionId: "worker", payload: { t: "view", to: "supervisor", bindingId: h.binding.id, view: "Incremental work", stopped: false } });
    await tick(); assert.equal(h.supervisor.compactions, 1);
    h.supervisor.idle = true;
    await h.supervisor.hook("agent_settled");
    assert.equal(h.supervisor.compactions, 2);
  } finally { await h.close(); }
});

test("a healthy goal review can take longer than ten minutes without cancellation or another pairing", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const h = pairHarness(); try {
    await h.start();
    const hash = planHash(readFileSync(h.planPath, "utf8"));
    const pending = h.worker.controller.review(h.binding.id, "first", hash);
    let failure: unknown; void pending.catch(error => { failure = error; });
    await tick(); await h.supervisor.hook("context", { messages: h.supervisor.contexts });
    h.supervisor.idle = false;
    t.mock.timers.tick(3_600_000); await tick();
    assert.equal(failure, undefined);
    assert.equal(h.supervisor.aborts, 0);
    assert.equal(h.wire.filter((wire: any) => wire.t === "goal_cancel").length, 0);
    await h.supervisor.review();
    assert.equal((await pending).decision, "approve");
    assert.equal(h.wire.filter((wire: any) => wire.t === "pair").length, 1);
    assert.equal(h.supervisor.compactions, 1);
  } finally { await h.close(); t.mock.timers.reset(); }
});

 test("busy plan supervisor refreshes cumulative VCC evidence without an idle feedback loop", async () => {
  const h = pairHarness(); try {
    await h.start(); await h.worker.controller.activate(h.binding.id); await tick();
    const active = (await h.supervisor.tools.get("worker_view").execute()).content[0].text;
    h.supervisor.idle = false;
    for (const text of ["First intervening evidence", "Second intervening evidence"]) {
      h.worker.entries.push({ type: "message", message: { role: "assistant", content: [{ type: "text", text }] } });
      for (let n = 0; n < 50; n++) await h.worker.hook("turn_end");
      await tick();
    }
    assert.equal(h.supervisor.messages.length, 1);
    assert.equal((await h.supervisor.tools.get("worker_view").execute()).content[0].text, active);
    await h.supervisor.tools.get("let_it_run").execute("finish", { reason: "Initial handoff is on course" }, undefined, undefined, h.supervisor.ctx);
    h.supervisor.idle = true; await h.supervisor.hook("agent_settled"); await tick();
    assert.equal(h.supervisor.messages.length, 2);
    assert.match(h.supervisor.messages[1].text, /First intervening evidence/);
    assert.match(h.supervisor.messages[1].text, /Second intervening evidence/);
    const count = h.wire.filter((wire: any) => wire.t === "look").length;
    await h.supervisor.tools.get("let_it_run").execute("finish-next", { reason: "Both receipts are consistent" }, undefined, undefined, h.supervisor.ctx);
    await h.supervisor.hook("agent_settled"); await tick();
    assert.equal(h.wire.filter((wire: any) => wire.t === "look").length, count);
    assert.equal(h.supervisor.messages.length, 2);
  } finally { await h.close(); }
});

test("progress during a refresh remains pending with only one look in flight", async () => {
  const h = pairHarness(); try {
    await h.start(); await h.worker.controller.activate(h.binding.id); await tick();
    const receive = h.worker.receive; const looks: any[] = [];
    h.worker.receive = (event: any) => { if (event.payload?.t === "look") looks.push(event); else receive(event); };
    const progress = async (text: string) => {
      h.worker.entries.push({ type: "message", message: { role: "assistant", content: [{ type: "text", text }] } });
      for (let n = 0; n < 50; n++) await h.worker.hook("turn_end"); await tick();
    };
    await progress("Before the refresh request");
    await h.supervisor.finishAssessment(); await tick(); assert.equal(looks.length, 1);
    await progress("While the complete overview is in flight");
    await h.supervisor.hook("agent_settled"); await tick(); assert.equal(looks.length, 1);
    receive(looks[0]); await tick();
    assert.match(h.supervisor.messages.at(-1).text, /Before the refresh request/);
    assert.match(h.supervisor.messages.at(-1).text, /While the complete overview is in flight/);
    await h.supervisor.finishAssessment(); await tick(); assert.equal(looks.length, 2);
    receive(looks[1]); await tick(); await h.supervisor.finishAssessment(); await tick();
    assert.equal(looks.length, 2, "no subsequent progress means no refresh feedback loop");
  } finally { await h.close(); }
});

for (const change of ["compaction", "rewind", "reload"] as const) test(`complete refresh uses the current worker branch after ${change}`, async () => {
  const h = pairHarness(); try {
    await h.start(); await h.worker.controller.activate(h.binding.id); await tick();
    h.worker.entries.push({ type: "message", message: { role: "assistant", content: [{ type: "text", text: "Pre-change evidence" }] } });
    for (let n = 0; n < 50; n++) await h.worker.hook("turn_end"); await tick();
    if (change === "compaction") h.worker.entries.push({ type: "compaction", summary: "Retained worker compaction evidence" });
    if (change === "rewind") h.worker.entries.splice(0, h.worker.entries.length, ...h.worker.entries.filter((entry: any) => entry.type === "custom"));
    h.worker.entries.push({ type: "message", message: { role: "assistant", content: [{ type: "text", text: "Current branch evidence" }] } });
    if (change === "reload") {
      h.supervisor.receive({ type: "session_left", sessionId: "worker" });
      await h.restart(h.worker, "returned-worker"); await tick();
    } else { await h.supervisor.finishAssessment(); await tick(); }
    const view = h.supervisor.messages.at(-1).text;
    assert.match(view, /Current branch evidence/);
    if (change === "compaction") assert.match(view, /Retained worker compaction evidence/);
    if (change === "rewind") assert.doesNotMatch(view, /Pre-change evidence/);
    assert.equal(h.wire.filter((wire: any) => wire.t === "pair").length, 1);
  } finally { await h.close(); }
});

test("explicit checkpoints wait separately from routine coalescing and do not replace an active assessment", async () => {
  const h = pairHarness(); try {
    await h.start(); await h.worker.controller.activate(h.binding.id); await tick();
    const active = (await h.supervisor.tools.get("worker_view").execute()).content[0].text;
    const pending = h.worker.controller.review(h.binding.id, "first", planHash(readFileSync(h.planPath, "utf8")));
    await tick();
    assert.equal(h.supervisor.contexts.filter((message: any) => message.customType === "supervisor_checkpoint").length, 0);
    assert.equal((await h.supervisor.tools.get("worker_view").execute()).content[0].text, active);
    await assert.rejects(h.supervisor.tools.get("review_goal").execute("unpresented", { decision: "approve", reason: "Not yet shown" }), /No matching/);
    await h.supervisor.finishAssessment(); await tick();
    assert.equal(h.supervisor.contexts.filter((message: any) => message.customType === "supervisor_checkpoint").length, 1);
    await h.supervisor.review("needs_user", "The user must choose the output format");
    assert.equal((await pending).decision, "needs_user");
    const looks = h.wire.filter((wire: any) => wire.t === "look").length;
    await h.supervisor.receive({ type: "message", fromSessionId: "worker", payload: { t: "view", to: "supervisor", bindingId: h.binding.id, view: "More routine status", stopped: false } });
    await tick();
    for (let n = 0; n < 3; n++) { await h.supervisor.hook("agent_settled"); await tick(); }
    assert.equal(h.wire.filter((wire: any) => wire.t === "look").length, looks, "a settled response must not poll idle work");
    assert.equal(h.supervisor.messages.length, 2, "a real needs_user decision must not discard subsequent views");
    await h.supervisor.finishAssessment();
    h.worker.entries.push({ type: "message", message: { role: "user", content: "Use text output; continue goal two now." } });
    await h.supervisor.commands.get("supervise").handler("look", h.supervisor.ctx); await tick();
    assert.match(h.supervisor.messages.at(-1).text, /Use text output; continue goal two now/);
  } finally { await h.close(); }
});

test("actual supervisor provider failure is returned explicitly without another pair or an elapsed-time cancellation", async () => {
  const h = pairHarness(); try {
    await h.start();
    const pending = h.worker.controller.review(h.binding.id, "first", planHash(readFileSync(h.planPath, "utf8"))); await tick();
    await h.supervisor.hook("agent_end", { messages: [{ role: "assistant", stopReason: "error", errorMessage: "Provider unavailable" }] });
    await h.supervisor.hook("agent_settled"); await tick();
    const result = await pending;
    assert.equal(result.decision, "needs_work"); assert.match(result.reason, /Provider unavailable/);
    assert.equal(h.wire.filter((wire: any) => wire.t === "pair").length, 1);
    assert.equal(h.wire.filter((wire: any) => wire.t === "goal_cancel").length, 0);
  } finally { await h.close(); }
});

test("a provider error followed by native retry success does not cancel the supervisor checkpoint", async () => {
  const h = pairHarness(); try {
    await h.start();
    const pending = h.worker.controller.review(h.binding.id, "first", planHash(readFileSync(h.planPath, "utf8"))); await tick();
    await h.supervisor.hook("agent_end", { messages: [{ role: "assistant", stopReason: "error", errorMessage: "Retryable provider error" }] });
    await tick();
    assert.equal(h.wire.filter((wire: any) => wire.t === "goal_decision" || wire.t === "goal_cancel").length, 0);
    await h.supervisor.hook("agent_end", { messages: [{ role: "assistant", stopReason: "toolUse" }] });
    await h.supervisor.review();
    assert.equal((await pending).decision, "approve");
    assert.equal(h.supervisor.aborts, 0);
  } finally { await h.close(); }
});

for (const retry of ["routine progress", "explicit look"] as const) test(`a failed full overview waits without spinning and recovers on ${retry}`, async () => {
  const h = pairHarness(); try {
    await h.start(); await h.worker.controller.activate(h.binding.id); await tick();
    h.worker.entries.push({ type: "message", message: { role: "assistant", content: [{ type: "text", text: "Evidence before publication failed" }] } });
    for (let n = 0; n < 50; n++) await h.worker.hook("turn_end"); await tick();
    let attempts = 0; let failing = true;
    h.worker.beforePublish = (payload: any) => {
      if (payload.t !== "view") return;
      attempts++;
      if (failing) throw new Error("One-shot Intercom publication failure");
    };
    await h.supervisor.finishAssessment(); await tick();
    assert.equal(attempts, 1);
    for (let n = 0; n < 3; n++) await tick();
    assert.equal(attempts, 1, "a failure must wait for an event or explicit retry, not recurse");
    assert.equal(h.supervisor.messages.length, 1, "publication failure is not assessment delivery");
    for (const [from, to, bindingId] of [["unrelated", "worker", h.binding.id], ["supervisor", "elsewhere", h.binding.id], ["supervisor", "worker", "stale-binding"]]) {
      h.worker.receive({ type: "message", fromSessionId: from, payload: { t: "look", to, bindingId } });
    }
    h.supervisor.receive({ type: "message", fromSessionId: "unrelated", payload: { t: "view", to: "supervisor", bindingId: h.binding.id, view: "Not the current worker", refreshed: true, stopped: true } });
    await tick(); assert.equal(attempts, 1); assert.equal(h.supervisor.messages.length, 1);
    failing = false;
    if (retry === "routine progress") {
      h.worker.entries.push({ type: "message", message: { role: "assistant", content: [{ type: "text", text: "Progress after transport restored" }] } });
      for (let n = 0; n < 50; n++) await h.worker.hook("turn_end");
    } else await h.supervisor.commands.get("supervise").handler("look", h.supervisor.ctx);
    await tick();
    assert.equal(attempts, 2);
    assert.equal(h.supervisor.messages.length, 2);
    const refreshed = h.wire.filter((wire: any) => wire.t === "view").at(-1);
    assert.equal(refreshed.refreshed, true, "the full overview request survives failed publication");
    assert.match(refreshed.view, /Evidence before publication failed/);
    assert.ok(refreshed.view.includes(h.binding.workerSession));
    if (retry === "routine progress") assert.match(refreshed.view, /Progress after transport restored/);
    await h.supervisor.finishAssessment(); await tick();
    assert.equal(attempts, 2, "success consumes the request without an idle feedback loop");
    assert.equal(h.wire.filter((wire: any) => wire.t === "pair").length, 1);
    assert.equal(h.wire.filter((wire: any) => wire.t === "goal_decision").length, 0);
  } finally { await h.close(); }
});

test("overview display metadata uses native context without requiring a remote roster lookup", async () => {
  const h = pairHarness(); try {
    await h.start(); await h.worker.controller.activate(h.binding.id); await tick();
    await h.supervisor.finishAssessment();
    let rosterRequests = 0;
    h.worker.beforeListSessions = () => { rosterRequests++; throw new Error("Roster timeout without disconnect"); };
    h.worker.ctx.getContextUsage = () => ({ tokens: 24_000, contextWindow: 200_000, percent: 12 });
    await h.supervisor.commands.get("supervise").handler("look", h.supervisor.ctx); await tick();
    assert.equal(rosterRequests, 0);
    assert.equal(h.supervisor.messages.length, 2);
    assert.match(h.supervisor.messages.at(-1).text, /native\/test, 12% of its context used/);
  } finally { await h.close(); }
});

for (const outcome of ["success", "rejection"] as const) test(`a superseded advance re-drives the current checkpoint after deferred compaction ${outcome}`, async () => {
  const h = pairHarness(); try {
    await h.start(); await h.worker.controller.activate(h.binding.id); await tick();
    h.supervisor.receive({ type: "message", fromSessionId: "worker", payload: { t: "view", to: "supervisor", bindingId: h.binding.id, view: "Pending routine work", stopped: false } });
    await tick();
    h.supervisor.tokens = 150_000;
    const compactions: any[] = [];
    h.supervisor.ctx.compact = (options: any) => { compactions.push(options); };
    const oldAdvance = h.supervisor.finishAssessment(); await tick();
    assert.equal(compactions.length, 1);
    h.supervisor.receive({ type: "session_left", sessionId: "worker" }); await tick();
    const acks = h.wire.filter((wire: any) => wire.t === "plan_hello_ack").length;
    h.supervisor.receive({ type: "message", fromSessionId: "returned-wrong-session", payload: { t: "plan_hello", to: "supervisor", bindingId: h.binding.id, role: "worker", sessionFile: "/not-the-worker" } });
    await tick(); assert.equal(h.wire.filter((wire: any) => wire.t === "plan_hello_ack").length, acks);
    await assert.rejects(h.supervisor.tools.get("steer").execute("wrong-peer", { message: "Not connected" }, undefined, undefined, h.supervisor.ctx), /Worker disconnected/);
    h.supervisor.receive({ type: "message", fromSessionId: "worker", payload: { t: "plan_hello", to: "supervisor", bindingId: h.binding.id, role: "worker", sessionFile: h.binding.workerSession } }); await tick();
    assert.equal(h.wire.filter((wire: any) => wire.t === "plan_hello_ack").length, acks + 1);
    const pending = h.worker.controller.review(h.binding.id, "first", planHash(readFileSync(h.planPath, "utf8")));
    void pending.catch(() => {}); await tick();
    assert.equal(compactions.length, 1, "no concurrent advance/compaction while the old one is outstanding");
    assert.equal(h.supervisor.contexts.filter((message: any) => message.customType === "supervisor_checkpoint").length, 0);
    if (outcome === "success") { h.supervisor.tokens = 10_000; compactions[0].onComplete({}); }
    else compactions[0].onError(new Error("Obsolete compaction failed"));
    await oldAdvance; await tick();
    if (outcome === "rejection") {
      assert.equal(compactions.length, 2, "only current work may retry compaction after the old rejection");
      h.supervisor.tokens = 10_000; compactions[1].onComplete({}); await tick();
    }
    assert.equal(h.supervisor.contexts.filter((message: any) => message.customType === "supervisor_checkpoint").length, 1);
    assert.equal(h.wire.filter((wire: any) => wire.t === "goal_decision").length, 0, "an obsolete failure cannot reject or approve the new checkpoint");
    await h.supervisor.review();
    assert.equal((await pending).decision, "approve");
    await tick(); await h.supervisor.finishAssessment(); await tick();
    const looks = h.wire.filter((wire: any) => wire.t === "look").length;
    await h.supervisor.hook("agent_settled"); await tick();
    assert.equal(h.wire.filter((wire: any) => wire.t === "look").length, looks);
    assert.equal(h.wire.filter((wire: any) => wire.t === "pair").length, 1);
    assert.equal(h.supervisor.aborts, 1, "only the actual disconnect aborts model work");
  } finally { await h.close(); }
});

for (const outcome of ["success", "rejection"] as const) test(`stopping current work during an obsolete advance prevents re-drive after compaction ${outcome}`, async () => {
  const h = pairHarness(); try {
    await h.start(); await h.worker.controller.activate(h.binding.id); await tick();
    h.supervisor.tokens = 150_000;
    let compact: any; let compactions = 0;
    h.supervisor.ctx.compact = (options: any) => { compact = options; compactions++; };
    const oldAdvance = h.supervisor.finishAssessment(); await tick();
    h.supervisor.receive({ type: "session_left", sessionId: "worker" }); await tick();
    h.supervisor.receive({ type: "message", fromSessionId: "worker", payload: { t: "plan_hello", to: "supervisor", bindingId: h.binding.id, role: "worker", sessionFile: h.binding.workerSession } }); await tick();
    const pending = h.worker.controller.review(h.binding.id, "first", planHash(readFileSync(h.planPath, "utf8")));
    const cancelled = assert.rejects(pending, /stopped/); await tick();
    await h.worker.controller.stop(h.binding.id); await cancelled; await tick();
    const wireCount = h.wire.length;
    if (outcome === "success") compact.onComplete({});
    else compact.onError(new Error("Obsolete compaction failed after stop"));
    await oldAdvance; await tick();
    assert.equal(compactions, 1);
    assert.equal(h.wire.length, wireCount, "stopped work does not retry, publish or approve");
    assert.equal(h.supervisor.contexts.filter((message: any) => message.customType === "supervisor_checkpoint").length, 0);
    assert.equal(h.supervisor.entries.at(-1).data.plan.stopped, true);
  } finally { await h.close(); }
});
