import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { backgroundState } from "../../src/internal/supervisor/background.js";
import extension from "../../src/internal/supervisor/index.js";
import { PLAN_API_EVENT, type PlanBinding, planHash } from "../../src/internal/supervisor/plan-api.js";

const tick = () => new Promise(resolve => setImmediate(resolve));
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
    const peer: any = { id, messages, contexts, entries, tools, commands, modelReady: true, activeProcesses: 0, activeSubagents: 0, idle: true, compactions: 0, tokens: 50_000, aborts: 0 };
    const bus = {
      on(name: string, handler: any) { const set = listeners.get(name) ?? new Set(); set.add(handler); listeners.set(name, set); return () => set.delete(handler); },
      emit(name: string, value: any) {
        if (name === "intercom:extension-register") {
          peer.receive = value.onEvent;
          value.onReady({ snapshot: () => ({ connected: true, supported: true }), listSessions: async () => peers.map(p => ({ id: p.id, pid: p === peer ? process.pid : process.pid + 1, cwd, model: "test" })), publish(payload: any) {
            wire.push({ from: peer.id, ...payload });
            for (const p of peers) queueMicrotask(() => p.receive?.({ type: "message", fromSessionId: peer.id, payload }));
          } }); return true;
        }
        if (name === "processes:request:list") value.reply(Array.from({ length: peer.activeProcesses }, () => ({ status: "running" })));
        if (name === "subagents:rpc:v1:request") bus.emit(`subagents:rpc:v1:reply:${value.requestId}`, { requestId: value.requestId, success: true, data: { fleet: { version: 1, totalActive: peer.activeSubagents } } });
        for (const handler of listeners.get(name) ?? []) handler(value);
      },
    };
    const pi: any = { events: bus, on(name: string, fn: any) { hooks.set(name, [...(hooks.get(name) ?? []), fn]); }, registerTool(tool: any) { tools.set(tool.name, tool); active.push(tool.name); }, registerCommand(name: string, command: any) { commands.set(name, command); }, appendEntry(customType: string, data: any) { entries.push({ type: "custom", customType, data }); }, getActiveTools: () => active, setActiveTools: (names: string[]) => { active = names; }, getAllTools: () => [{ name: "subagent" }], sendMessage: (message: any) => contexts.push(message), sendUserMessage: (text: string, options: any) => messages.push({ text, options }) };
    const ctx: any = { cwd, hasUI: true, model: { contextWindow: 200_000 }, isIdle: () => peer.idle, abort: () => { peer.aborts++; }, getContextUsage: () => ({ tokens: peer.tokens }), compact({ onComplete }: any) { peer.compactions++; peer.tokens = 10_000; onComplete({}); }, ui: { notify() {}, setStatus() {}, theme: { fg: (_: any, text: string) => text } }, sessionManager: { getEntries: () => entries, getBranch: () => entries, getSessionFile: () => sessionFile } };
    peer.pi = pi; peer.ctx = ctx;
    peer.hook = async (name: string, event = {}) => { for (const fn of hooks.get(name) ?? []) await fn(event, ctx); };
    peer.request = (method: string, params: any = {}) => new Promise<any>((resolve, reject) => bus.emit(PLAN_API_EVENT, { version: 1, method, ...params, resolve, reject }));
    peers.push(peer); extension(pi, () => peer.modelReady); return peer;
  }
  const worker = make("worker"); const supervisor = make("supervisor");
  return { worker, supervisor, binding, wire, planPath, async restart(peer: any, id: string) { await peer.hook("session_shutdown"); peers.splice(peers.indexOf(peer), 1); const replacement = make(id, structuredClone(peer.entries), peer.ctx.sessionManager.getSessionFile()); await replacement.hook("session_start"); await tick(); return replacement; }, async start() { await worker.hook("session_start"); await supervisor.hook("session_start"); await worker.request("prepare", { binding }); const attached = worker.request("attached", { bindingId: binding.id }); void attached.catch(() => {}); await supervisor.request("bootstrap", { binding, workerId: "worker" }); await attached; }, async close() { for (const peer of peers) await peer.hook("session_shutdown"); rmSync(cwd, { recursive: true, force: true }); } };
}

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
      const req = h.wire.findLast((w: any) => w.t === "goal_review");
      await assert.rejects(h.supervisor.tools.get("done").execute("", { reason: "done" }, undefined, undefined, h.supervisor.ctx), /Open plan goals/);
      await assert.rejects(h.supervisor.tools.get("review_goal").execute("", { requestId: "stale", decision: "approve", reason: "ok" }), /No matching/);
      await h.supervisor.tools.get("review_goal").execute("", { requestId: req.requestId, decision: "approve", reason: "Faithful to the plan" });
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
  const result = await backgroundState({ events: { emit() {} }, getAllTools: () => [] });
  assert.equal(result.quiet, false); assert.match(result.description, /unknown/);
});

test("stale plan content invalidates a pending goal review", async () => {
  const h = pairHarness(); try {
    await h.start(); const abort = new AbortController();
    const pending = h.worker.request("review", { bindingId: h.binding.id, goal: "first", planHash: planHash(readFileSync(h.planPath, "utf8")), signal: abort.signal });
    const rejected = assert.rejects(pending, /cancelled/); await tick();
    const req = h.wire.findLast((w: any) => w.t === "goal_review"); writeFileSync(h.planPath, "Human changed the requirement");
    await assert.rejects(h.supervisor.tools.get("review_goal").execute("", { requestId: req.requestId, decision: "approve", reason: "ok" }), /Plan changed/);
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
    const pending = reloaded.request("review", { bindingId: h.binding.id, goal: "first", planHash: planHash(readFileSync(h.planPath, "utf8")) }); await tick();
    const req = h.wire.findLast((w: any) => w.t === "goal_review");
    await h.supervisor.tools.get("review_goal").execute("", { requestId: req.requestId, decision: "approve", reason: "Same plan" });
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
    h.supervisor.tokens = 100_001;
    await h.supervisor.receive({ type: "message", fromSessionId: "worker", payload: { t: "view", to: "supervisor", view: "New work since compaction", stopped: false } });
    await tick();
    assert.equal(h.supervisor.compactions, 2);
  } finally { await h.close(); }
});

test("stopping a routine view during compaction invalidates its suspended continuation", async () => {
  const h = pairHarness(); let finish!: () => void;
  try {
    await h.start(); await h.worker.request("activate", { bindingId: h.binding.id }); await tick();
    h.supervisor.tokens = 150_000;
    h.supervisor.ctx.compact = ({ onComplete }: any) => { finish = onComplete; };
    h.supervisor.receive({ type: "message", fromSessionId: "worker", payload: { t: "view", to: "supervisor", view: "Must not restart the stopped supervisor", stopped: false } });
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
