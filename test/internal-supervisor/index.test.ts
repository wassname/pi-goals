import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const INTERCOM_EXTENSION_REGISTER_EVENT = "intercom:extension-register";
const INTERCOM_EXTENSION_REGISTRY_READY_EVENT = "intercom:extension-registry-ready";

import extension, { PROGRAMMATIC_PAIR_EVENT } from "../../src/internal/supervisor/index.js";
import { isWire, overlap, restoreState, STATE_ENTRY, STEER_MEMORY } from "../../src/internal/supervisor/protocol.js";
import { buildView } from "../../src/internal/supervisor/view.js";

test("retries intercom registration when pi-intercom loads after pi-supervise", () => {
  const bus = new EventEmitter();
  const registrations: unknown[] = [];
  const pi = {
    events: {
      emit: (name: string, value: unknown) => bus.emit(name, value),
      on: (name: string, handler: (...args: any[]) => void) => bus.on(name, handler),
    },
    on() {},
    registerCommand() {},
    registerTool() {},
    appendEntry() {},
    getActiveTools: () => [],
    setActiveTools() {},
    sendMessage() {},
    sendUserMessage() {},
  };
  extension(pi);
  bus.on(INTERCOM_EXTENSION_REGISTER_EVENT, (registration) => registrations.push(registration));
  bus.emit(INTERCOM_EXTENSION_REGISTRY_READY_EVENT, { version: 1 });
  bus.emit(INTERCOM_EXTENSION_REGISTRY_READY_EVENT, { version: 1 });
  assert.equal(registrations.length, 1);
});

test("a directive with no text is rejected, so the worker never sees undefined", () => {
  assert.equal(isWire({ t: "directive", to: "x", text: "do it" }), true);
  assert.equal(isWire({ t: "directive", to: "x" }), false);
  assert.equal(isWire({ t: "directive", to: "x", text: "   " }), false);
  assert.equal(isWire({ t: "view", to: "x" }), false);
  assert.equal(isWire({ t: "pair", to: "x", goal: "g" }), true);
});

const WORKER_ID = "session-worker";
const SUPER_ID = "session-supervisor";

/** Fake ExtensionAPI, same shape as pi-intercom's own test harness. */
function harness(
  ownId: string,
  {
    entries = [] as any[],
    isIdle = true,
    branch = undefined as any[] | undefined,
    extraSessions = [] as any[],
    /** Which sessions answer a roll call. The extras stay quiet, the way a child run does. */
    freeSessions = undefined as string[] | undefined,
    /** Which option the human picks when /supervise has to ask. undefined is a cancelled dialog. */
    pick = undefined as number | undefined,
  } = {},
) {
  const bus = new EventEmitter();
  const handlers = new Map<string, Array<(e: any, c: any) => any>>();
  const commands = new Map<string, (args: string, ctx: any) => any>();
  const tools = new Map<string, any>();
  const appended: Array<{ type: string; data: any }> = [];
  const userMessages: Array<{ content: string; options?: any }> = [];
  const contextMessages: Array<{ content: string; options?: any }> = [];
  const published: any[] = [];
  const notices: string[] = [];
  const selects: Array<{ title: string; options: string[] }> = [];
  const aborts: boolean[] = [];
  let onEvent: (e: any) => void = () => {};

  const peerId = ownId === WORKER_ID ? SUPER_ID : WORKER_ID;
  const answering = freeSessions ?? [peerId];

  const channel = {
    namespace: "test",
    snapshot: () => ({ connected: true, supported: true }),
    publish: (payload: any) => {
      published.push(payload);
      // The other sessions answer the roll call, which is what /supervise waits for.
      if (payload?.t === "who") {
        for (const id of answering) {
          queueMicrotask(() => onEvent({ type: "message", fromSessionId: id, payload: { t: "here", to: ownId } }));
        }
      }
    },
    commitState: () => {},
    listSessions: async () => [
      // model and contextPct are on the real SessionInfo (pi-intercom/types.ts), pushed by presence.
      // The view header reads them off our own record, so a session missing them fails a test here.
      { id: ownId, pid: process.pid, name: ownId === WORKER_ID ? "worker" : "supervisor", cwd: process.cwd(), model: "test/tiny", contextPct: 12 },
      {
        id: ownId === WORKER_ID ? SUPER_ID : WORKER_ID,
        pid: process.pid + 1,
        name: ownId === WORKER_ID ? "supervisor" : "worker",
        cwd: process.cwd(),
        model: "test/tiny",
      },
      ...extraSessions,
    ],
  };

  const pi = {
    events: {
      emit: (channelName: string, payload: any) => {
        if (channelName === INTERCOM_EXTENSION_REGISTER_EVENT) {
          onEvent = payload.onEvent;
          payload.onReady(channel);
        }
        bus.emit(channelName, payload);
      },
      on: (name: string, fn: any) => bus.on(name, fn),
    },
    on: (event: string, fn: any) => {
      handlers.set(event, [...(handlers.get(event) ?? []), fn]);
    },
    registerCommand: (name: string, opts: any) => commands.set(name, opts.handler),
    // A registered tool is active in pi, which is why a worker could see steer and worker_view.
    registerTool: (tool: any) => {
      tools.set(tool.name, tool);
      activeTools = [...activeTools, tool.name];
    },
    appendEntry: (type: string, data: any) => appended.push({ type, data }),
    sendUserMessage: (content: string, options?: any) => userMessages.push({ content, options }),
    // pi's own sendMessage: a CustomMessageEntry, in the LLM context, and with triggerTurn false it
    // starts no turn (session-manager.d.ts:85, agent-session.d.ts:398).
    sendMessage: (message: any, options?: any) => contextMessages.push({ content: message.content, options }),
    // On the pi API, NOT on the command context. Putting them on the context here is what hid a
    // real bug: the live command handler threw "context.getActiveTools is not a function", and
    // before that the optional call returned undefined and the strip skipped in silence.
    getActiveTools: () => activeTools,
    setActiveTools: (names: string[]) => {
      activeTools = names;
    },
  };

  let activeTools = ["read", "grep", "list", "bash", "edit", "write"];
  const status = new Map<string, string | undefined>();
  const ctx = {
    cwd: process.cwd(),
    isIdle: () => isIdle,
    hasUI: true,
    // pi's own ExtensionContext.abort(): stops the agent loop before its next model call.
    abort: () => aborts.push(true),
    ui: {
      notify: (m: string) => notices.push(m),
      // pi's own ExtensionUIContext.select: returns the chosen option, or undefined if cancelled.
      select: async (title: string, options: string[]) => {
        selects.push({ title, options });
        return pick === undefined ? undefined : options[pick];
      },
      // Same shape as @diegopetrucci/pi-oracle uses: setStatus(id, text) with theme.fg for colour.
      setStatus: (id: string, text: string | undefined) => status.set(id, text),
      theme: { fg: (_colour: string, text: string) => text },
    },
    sessionManager: {
      getSessionId: () => ownId,
      getEntries: () => entries,
      // Deliberately different from getEntries, so a test can tell which one the view reads.
      getBranch: () => branch ?? entries,
    },
  };

  return {
    pi,
    ctx,
    tools,
    appended,
    userMessages,
    contextMessages,
    published,
    notices,
    selects,
    aborts,
    status,
    async start() {
      extension(pi as any);
      for (const fn of handlers.get("session_start") ?? []) await fn({}, ctx);
    },
    async settle() {
      for (const fn of handlers.get("agent_settled") ?? []) await fn({}, ctx);
    },
    async turnStart() {
      for (const fn of handlers.get("turn_start") ?? []) await fn({}, ctx);
    },
    /** One per run, before the first model call (pi-agent-core agent-loop.js:48). */
    async agentStart() {
      for (const fn of handlers.get("agent_start") ?? []) await fn({}, ctx);
    },
    async compact(willRetry = false) {
      for (const fn of handlers.get("session_compact") ?? []) await fn({ willRetry }, ctx);
    },
    async run(command: string, args: string) {
      await commands.get(command)!(args, ctx);
    },
    /** Deliver a wire message as if it came from another session, with a broker-stamped sender. */
    deliver(fromSessionId: string, payload: unknown) {
      onEvent({ type: "message", fromSessionId, payload });
    },
    pair(workerIntercomId: string, goal: string) {
      return new Promise<void>((resolve, reject) => {
        bus.emit(PROGRAMMATIC_PAIR_EVENT, { version: 1, workerIntercomId, goal, resolve, reject });
      });
    },
    /** Fired before every model call. Returns what the model would actually be sent. */
    async context(messages: any[]) {
      let out = messages;
      for (const fn of handlers.get("context") ?? []) out = (await fn({ messages: out }, ctx))?.messages ?? out;
      return out;
    },
  };
}

const message = (role: string, text: string) => ({
  type: "message",
  message: { role, content: [{ type: "text", text }] },
});

test("a directive from the paired supervisor becomes a real user message", async () => {
  const worker = harness(WORKER_ID);
  await worker.start();
  worker.deliver(SUPER_ID, { t: "pair", to: WORKER_ID, goal: "make the table" });
  await new Promise((r) => setTimeout(r, 5));

  worker.deliver(SUPER_ID, { t: "directive", to: WORKER_ID, text: "read the log first" });
  await new Promise((r) => setTimeout(r, 5));

  assert.equal(worker.userMessages.length, 1);
  assert.equal(worker.userMessages[0].content, "[supervisor] read the log first");
  // Idle worker takes no deliverAs, so the message triggers a turn instead of queueing forever.
  assert.equal(worker.userMessages[0].options, undefined);
});

test("a directive to a busy worker interrupts, instead of waiting for the whole task", async () => {
  // Seen in a real run: the supervisor corrected the worker mid-task and the correction never
  // arrived, because followUp waits for the agent to finish everything.
  const worker = harness(WORKER_ID, { isIdle: false });
  await worker.start();
  worker.deliver(SUPER_ID, { t: "pair", to: WORKER_ID, goal: "g" });
  await new Promise((r) => setTimeout(r, 5));

  worker.deliver(SUPER_ID, { t: "directive", to: WORKER_ID, text: "it is Cthulhu, not clutho" });
  await new Promise((r) => setTimeout(r, 5));

  assert.equal(worker.userMessages.length, 1);
  assert.deepEqual(worker.userMessages[0].options, { deliverAs: "steer" });
});

test("a directive from an unpaired session is dropped", async () => {
  const worker = harness(WORKER_ID);
  await worker.start();
  worker.deliver(SUPER_ID, { t: "pair", to: WORKER_ID, goal: "g" });
  await new Promise((r) => setTimeout(r, 5));

  worker.deliver("session-impostor", { t: "directive", to: WORKER_ID, text: "rm -rf /" });
  await new Promise((r) => setTimeout(r, 5));

  assert.deepEqual(worker.userMessages, []);
});

test("a second pair takes over, and the first supervisor is told it lost the worker", async () => {
  // First-wins left a worker bound forever to a supervisor that had already died, and told nobody.
  const worker = harness(WORKER_ID);
  await worker.start();
  worker.deliver(SUPER_ID, { t: "pair", to: WORKER_ID, goal: "first" });
  await new Promise((r) => setTimeout(r, 5));
  worker.deliver("session-second", { t: "pair", to: WORKER_ID, goal: "second" });
  await new Promise((r) => setTimeout(r, 5));

  assert.deepEqual(
    worker.published.filter((p) => p.t === "unpair"),
    [{ t: "unpair", to: SUPER_ID }],
    "the supervisor that lost the worker must hear about it",
  );
  worker.deliver(SUPER_ID, { t: "directive", to: WORKER_ID, text: "obey me" });
  await new Promise((r) => setTimeout(r, 5));
  assert.deepEqual(worker.userMessages, [], "the old supervisor can no longer steer");

  worker.deliver("session-second", { t: "directive", to: WORKER_ID, text: "now do this" });
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(worker.userMessages.length, 1, "the new supervisor can");
});

test("only the paired worker can end a run", async () => {
  // A worker that has moved to another supervisor sends unpair to the one it left. That must not
  // reach a supervisor which has itself moved on, or a live run ends and nobody asked for it.
  const sup = harness(SUPER_ID);
  await sup.start();
  await sup.run("supervise", "@worker g");
  sup.deliver("session-a-worker-we-left", { t: "unpair", to: SUPER_ID });
  sup.deliver("session-a-worker-we-left", { t: "done", to: SUPER_ID, reason: "I decided we are finished" });
  await new Promise((r) => setTimeout(r, 5));

  const steer = await sup.tools.get("steer")!.execute("id", { message: "carry on" }, undefined, undefined, sup.ctx);
  assert.ok(!steer.isError, `supervision must still be running, got ${steer.content[0].text}`);
});

test("the programmatic pairing API waits for the worker acknowledgement", async () => {
  const supervisor = harness(SUPER_ID);
  await supervisor.start();
  const paired = supervisor.pair(WORKER_ID, "make the table");
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(supervisor.published.filter((payload) => payload.t === "pair"), [{ t: "pair", to: WORKER_ID, goal: "make the table" }]);
  supervisor.deliver(WORKER_ID, { t: "paired", to: SUPER_ID });
  await paired;
});

test("the worker acknowledges a pair, so the supervisor knows it was heard", async () => {
  const worker = harness(WORKER_ID);
  await worker.start();
  worker.deliver(SUPER_ID, { t: "pair", to: WORKER_ID, goal: "g" });
  await new Promise((r) => setTimeout(r, 5));
  assert.deepEqual(worker.published.filter((p) => p.t === "paired"), [{ t: "paired", to: SUPER_ID }]);
});

test("a goal the supervisor inferred reaches the worker, which owns the view header", async () => {
  const worker = harness(WORKER_ID, { entries: [message("user", "do the thing")] });
  await worker.start();
  worker.deliver(SUPER_ID, { t: "pair", to: WORKER_ID, goal: "" });
  await new Promise((r) => setTimeout(r, 5));
  await worker.settle();
  assert.match(worker.published.find((p) => p.t === "view").view, /^<goal>\nnot set\n<\/goal>$/m, "no goal yet");

  worker.deliver(SUPER_ID, { t: "goal", to: WORKER_ID, goal: "make the results table" });
  await new Promise((r) => setTimeout(r, 5));
  await worker.settle();
  const views = worker.published.filter((p) => p.t === "view");
  assert.match(views[views.length - 1].view, /^<goal>\nmake the results table\n<\/goal>$/m, "the header must follow set_goal");
});

test("the second view carries only what happened after the first", async () => {
  // Without the mark advancing, review N re-sends reviews 1..N-1 into a session that has them.
  const entries = [message("user", "THE FIRST INSTRUCTION")];
  const worker = harness(WORKER_ID, { entries });
  await worker.start();
  worker.deliver(SUPER_ID, { t: "pair", to: WORKER_ID, goal: "g" });
  // 300ms, not 5: the pairing view runs ps, and a pairing that lands after the second settle sets
  // the sent-turns mark past the turn this test is looking for. That flaked about one run in four.
  await new Promise((r) => setTimeout(r, 300));

  await worker.settle();
  assert.match(worker.published.find((p) => p.t === "view").view, /THE FIRST INSTRUCTION/);

  entries.push(message("assistant", "THE SECOND THING"));
  await worker.settle();
  const second = worker.published.filter((p) => p.t === "view").at(-1).view;
  assert.match(second, /THE SECOND THING/);
  assert.doesNotMatch(second, /THE FIRST INSTRUCTION/, "the supervisor already read this one");
});

test("a message addressed to a different session is ignored", async () => {
  const worker = harness(WORKER_ID);
  await worker.start();
  worker.deliver(SUPER_ID, { t: "pair", to: "some-other-worker", goal: "not for us" });
  await new Promise((r) => setTimeout(r, 5));

  worker.deliver(SUPER_ID, { t: "directive", to: WORKER_ID, text: "hello" });
  await new Promise((r) => setTimeout(r, 5));
  assert.deepEqual(worker.userMessages, []);
});

test("on settle the worker publishes a view built from the live branch", async () => {
  const worker = harness(WORKER_ID, { entries: [message("user", "do the thing"), message("assistant", "done")] });
  await worker.start();
  worker.deliver(SUPER_ID, { t: "pair", to: WORKER_ID, goal: "the goal" });
  await new Promise((r) => setTimeout(r, 5));

  await worker.settle();
  const view = worker.published.find((p) => p.t === "view");
  assert.ok(view, "expected a view publish");
  assert.equal(view.to, SUPER_ID);
  assert.match(view.view, /<goal>\nthe goal\n<\/goal>/);
  assert.match(view.view, /do the thing/);
});

test("the view is built from the live branch, not from every entry in the session", async () => {
  // An abandoned fork leaves entries in getEntries that getBranch drops. Reading the wrong one
  // makes the supervisor judge work that was undone.
  const worker = harness(WORKER_ID, {
    entries: [message("user", "ABANDONED after a rewind"), message("user", "kept on the live branch")],
    branch: [message("user", "kept on the live branch")],
  });
  await worker.start();
  worker.deliver(SUPER_ID, { t: "pair", to: WORKER_ID, goal: "g" });
  await new Promise((r) => setTimeout(r, 5));

  await worker.settle();
  const view = worker.published.find((p) => p.t === "view");
  assert.match(view.view, /kept on the live branch/);
  assert.doesNotMatch(view.view, /ABANDONED after a rewind/);
});

test("an unpaired session publishes nothing on settle", async () => {
  const lone = harness(WORKER_ID, { entries: [message("user", "hi")] });
  await lone.start();
  await lone.settle();
  assert.deepEqual(lone.published, []);
});

test("supervision never stops itself: no round limit at all", async () => {
  // wassname: "I want no budget at all! I want long until human stops". Ending early is the
  // failure this extension exists to prevent, so a cap would be a competing objective.
  const sup = harness(SUPER_ID);
  await sup.start();
  await sup.run("supervise", "@worker do the thing");

  const steer = sup.tools.get("steer")!;
  for (let i = 0; i < 200; i++) {
    const result = await steer.execute("id", { message: `instruction ${i}` }, undefined, undefined, sup.ctx);
    assert.ok(!result.isError, `instruction ${i} must be allowed, got ${result.content[0].text}`);
  }
});

test("goal, pairing and the steer count all survive a reload together", async () => {
  const first = harness(SUPER_ID);
  await first.start();
  await first.run("supervise", "@worker make the results table");
  const steer = first.tools.get("steer")!;
  for (let i = 0; i < 3; i++) {
    await steer.execute("id", { message: `instruction ${i}` }, undefined, undefined, first.ctx);
  }

  const carried = first.appended
    .filter((e) => e.type === STATE_ENTRY)
    .map((e) => ({ type: "custom", customType: e.type, data: e.data }));
  const restored = restoreState(carried);
  assert.equal(restored.goal, "make the results table");
  assert.equal(restored.pairedId, WORKER_ID);
  assert.equal(restored.steerRounds, 3);
  assert.deepEqual(restored.recentSteers, ["instruction 0", "instruction 1", "instruction 2"]);
});

test("a view that arrives while the supervisor is thinking is queued, not dropped", async () => {
  // pi throws "Agent is already processing" when sendUserMessage gets no delivery option, and the
  // catch upstream turns that into a dropped message. On a half hour look the supervisor would
  // silently skip a whole look.
  const sup = harness(SUPER_ID, { isIdle: false });
  await sup.start();
  await sup.run("supervise", "@worker g");
  sup.userMessages.length = 0;
  sup.deliver(WORKER_ID, { t: "view", to: SUPER_ID, view: "# Goal: g\n", stopped: true });
  await new Promise((r) => setTimeout(r, 5));

  assert.equal(sup.userMessages.length, 1, "the view must still reach the supervisor");
  assert.deepEqual(sup.userMessages[0].options, { deliverAs: "followUp" });
});

test("the nudge repeats neither the instructions already sent nor the verdict rules", async () => {
  // Both used to be in every nudge. The steer calls are already in the supervisor's own context,
  // and the verdict rules are in the tool descriptions, which the API sends at every model call.
  const sup = harness(SUPER_ID);
  await sup.start();
  await sup.run("supervise", "@worker fix the tests");
  const steer = sup.tools.get("steer")!;
  for (let i = 0; i < STEER_MEMORY + 3; i++) {
    await steer.execute("id", { message: `instruction ${i}` }, undefined, undefined, sup.ctx);
  }

  sup.userMessages.length = 0;
  sup.deliver(WORKER_ID, { t: "view", to: SUPER_ID, view: "# Goal: fix the tests\n", stopped: true });
  await new Promise((r) => setTimeout(r, 5));

  const nudge = sup.userMessages.at(-1)!.content;
  assert.doesNotMatch(nudge, /instruction \d/, "the supervisor already has its own steer calls");
  assert.match(nudge, new RegExp(`${STEER_MEMORY + 3} instructions so far`), "the count is the cheap part, so it stays");
  assert.ok(nudge.length < 400, `the nudge is sent every look, so it stays short: ${nudge.length} chars`);
});

test("a multi-line goal returns to supervisor context every fifth review and after compaction", async () => {
  const goal = "Build the causal evaluation.\nThe full rubric stays here.";
  const sup = harness(SUPER_ID);
  await sup.start();
  await sup.run("supervise", `@worker ${goal}`);
  const atPairing = sup.contextMessages.length;
  assert.match(sup.contextMessages.at(-1)!.content, /<goal>\nBuild the causal evaluation\.\nThe full rubric stays here\.\n<\/goal>/);

  for (let i = 0; i < 4; i++) {
    sup.deliver(WORKER_ID, { t: "view", to: SUPER_ID, view: `view ${i}`, stopped: true });
    await new Promise((r) => setTimeout(r, 5));
  }
  assert.equal(sup.contextMessages.length, atPairing, "the brief already gave the supervisor the full goal");

  sup.deliver(WORKER_ID, { t: "view", to: SUPER_ID, view: "view 4", stopped: true });
  await new Promise((r) => setTimeout(r, 5));
  assert.match(sup.contextMessages.at(-1)!.content, /<goal>\nBuild the causal evaluation\.\nThe full rubric stays here\.\n<\/goal>/);

  const afterReview = sup.contextMessages.length;
  await sup.compact();
  assert.equal(sup.contextMessages.length, afterReview + 1);
  assert.match(sup.contextMessages.at(-1)!.content, /The full rubric stays here/);

  const afterCompaction = sup.contextMessages.length;
  await sup.compact(true);
  assert.equal(sup.contextMessages.length, afterCompaction, "overflow recovery removes its failed reply after session_compact");
  sup.deliver(WORKER_ID, { t: "view", to: SUPER_ID, view: "view after recovery", stopped: true });
  await new Promise((r) => setTimeout(r, 5));
  assert.match(sup.contextMessages.at(-1)!.content, /The full rubric stays here/, "the next ordinary review restores the rubric");
});

test("a one-line goal is not redundantly reinserted", async () => {
  const sup = harness(SUPER_ID);
  await sup.start();
  await sup.run("supervise", "@worker fix the parser");
  const atPairing = sup.contextMessages.length;

  for (let i = 0; i < 5; i++) {
    sup.deliver(WORKER_ID, { t: "view", to: SUPER_ID, view: `view ${i}`, stopped: true });
    await new Promise((r) => setTimeout(r, 5));
  }
  assert.equal(sup.contextMessages.length, atPairing);
});

test("a check in and a worker that stopped ask for different things", async () => {
  // Interrupting a working agent costs it its train of thought, so a check in leans on wait.
  const sup = harness(SUPER_ID);
  await sup.start();
  await sup.run("supervise", "@worker fix the tests");

  sup.userMessages.length = 0;
  sup.deliver(WORKER_ID, { t: "view", to: SUPER_ID, view: "# Goal: g\n", stopped: false });
  await new Promise((r) => setTimeout(r, 5));
  assert.match(sup.userMessages.at(-1)!.content, /Call let_it_run unless the view gives concrete evidence/);

  sup.deliver(WORKER_ID, { t: "view", to: SUPER_ID, view: "# Goal: g\n", stopped: true });
  await new Promise((r) => setTimeout(r, 5));
  assert.match(sup.userMessages.at(-1)!.content, /The worker stopped/);
});

test("a loop still gets named after the supervisor compacts, from restored state", async () => {
  // The nudge no longer lists past instructions, so this is the only thing left that catches a
  // repeat once a compaction has taken the supervisor's own steer calls out of its context.
  const first = harness(SUPER_ID);
  await first.start();
  await first.run("supervise", "@worker fix the tests");
  await first.tools.get("steer")!
    .execute("id", { message: "Run the failing parser tests and fix the first failure" }, undefined, undefined, first.ctx);

  const carried = first.appended
    .filter((e) => e.type === STATE_ENTRY)
    .map((e) => ({ type: "custom", customType: e.type, data: e.data }));
  const after = harness(SUPER_ID, { entries: carried });
  await after.start();
  const again = await after.tools.get("steer")!
    .execute("id", { message: "Please run those parser tests again and fix whatever failure comes first" }, undefined, undefined, after.ctx);

  assert.match(again.content[0].text, /says much the same as instruction 1/);
});

test("a session that does not answer the roll call is not offered as a worker", async () => {
  // Real names from wassname's terminal 2026-08-13: pi-subagents registers every child run with
  // the broker, so /supervise saw "5 other sessions" and refused to pick the one real worker.
  // Steering a child run is meaningless anyway, it dies when its task ends.
  const sup = harness(SUPER_ID, {
    extraSessions: [
      { id: "019ff8ac-1", pid: 1, name: "general-purpose#f818354d", cwd: process.cwd() },
      { id: "019ff8ac-2", pid: 2, name: "general-purpose#18c778eb", cwd: process.cwd() },
      { id: "019ff807", pid: 3, name: "subagent-chat-019ff807-e4ce-7f4d", cwd: process.cwd() },
    ],
  });
  await sup.start();
  await sup.run("supervise", "make the results table");

  assert.deepEqual(
    sup.published.filter((p) => p.t === "pair"),
    [{ t: "pair", to: WORKER_ID, goal: "make the results table" }],
    "the one session that answered is the worker, whatever the child runs are doing",
  );
});

test("a child run stays out of the roll call, so it can never be picked", async () => {
  process.env.PI_SUBAGENT_CHILD = "1"; // pi-subagents sets this in every session it starts
  try {
    const child = harness(WORKER_ID);
    await child.start();
    child.deliver(SUPER_ID, { t: "who", to: "*" });
    await new Promise((r) => setTimeout(r, 5));
    assert.deepEqual(child.published.filter((p) => p.t === "here"), []);
  } finally {
    delete process.env.PI_SUBAGENT_CHILD;
  }
});

test("a session already paired stays out of the roll call, and a free one answers", async () => {
  const worker = harness(WORKER_ID);
  await worker.start();
  worker.deliver("session-asking", { t: "who", to: "*" });
  await new Promise((r) => setTimeout(r, 5));
  assert.deepEqual(
    worker.published.filter((p) => p.t === "here"),
    [{ t: "here", to: "session-asking" }],
    "free, so it puts itself forward",
  );

  worker.deliver(SUPER_ID, { t: "pair", to: WORKER_ID, goal: "g" });
  await new Promise((r) => setTimeout(r, 5));
  worker.deliver("session-asking", { t: "who", to: "*" });
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(
    worker.published.filter((p) => p.t === "here").length,
    1,
    "taken, so a second supervisor is not offered it",
  );
});

test("/supervise look asks the worker for a fresh view, rather than the supervisor guessing", async () => {
  // A supervisor whose turn ended without a view has no way back: only the worker makes views.
  // wassname hit this when the supervisor died on an OpenRouter 402, and poking it with "," made
  // it work from stale context and invent facts.
  const sup = harness(SUPER_ID);
  await sup.start();
  await sup.run("supervise", "@worker make the results table");
  await sup.run("supervise", "look");
  assert.deepEqual(sup.published.filter((p) => p.t === "look"), [{ t: "look", to: WORKER_ID }]);

  // And the worker answers with a view, so the round trip is real.
  const worker = harness(WORKER_ID, { entries: [message("assistant", "WHAT I DID LAST")] });
  await worker.start();
  worker.deliver(SUPER_ID, { t: "pair", to: WORKER_ID, goal: "g" });
  await new Promise((r) => setTimeout(r, 5));
  worker.deliver(SUPER_ID, { t: "look", to: WORKER_ID });
  // The view waits on a real ps call for child pi processes, which takes tens of milliseconds.
  await new Promise((r) => setTimeout(r, 300));

  const view = worker.published.filter((p) => p.t === "view").at(-1);
  // The whole transcript, not the diff, even though the pairing view already sent it. A supervisor
  // asks for a look when its own copy is gone, so "nothing new since your last look" is no answer.
  assert.match(view.view, /WHAT I DID LAST/);
  assert.equal(view.stopped, true, "this worker is idle, and the flag follows the worker not the trigger");
});

test("let_it_run says the turn is over, so it is not called four times running", async () => {
  // Observed 2026-08-12 in session 019ff458-4578: wait at 06:21:52, 06:22:13, 06:22:25 and
  // 06:22:32, then "I keep calling wait in a loop ... I should end my turn now". A tool result
  // reads as a prompt to act again, so the result has to say the turn is finished.
  const sup = harness(SUPER_ID);
  await sup.start();
  await sup.run("supervise", "@worker make the results table");

  const result = await sup.tools.get("let_it_run")!.execute("id", { reason: "job 291 is at 305 of 600" }, undefined, undefined, sup.ctx);
  assert.match(result.content[0].text, /job 291 is at 305 of 600/, "the reason is still recorded");
  assert.match(result.content[0].text, /completed its verdict for the current worker view/);
  // The result must name a way to end the turn. "Say nothing more" named none, and a model that
  // may not write text can only call another tool, which is what session 019ffa73 did every look.
  assert.match(result.content[0].text, /write one short line or no text/);
  assert.doesNotMatch(result.content[0].text, /Say nothing more/);
});

test("a sign-off verdict is answered, not aborted, and a runaway is still cut", async () => {
  // Session 019ffa73, 2026-08-13, sixteen times before 11:05Z: let_it_run "job 23 progressing normally
  // (438/600 steps)", then let_it_run "waiting for job 23 to reach Evidence-b", then an empty
  // assistant message with errorMessage "This operation was aborted". Both reasons were true, so
  // the second call was the model signing off and the abort made a normal look look like a fault.
  // Session 019ffa5f is the case the cut is still for: 645 calls.
  const sup = harness(SUPER_ID);
  await sup.start();
  await sup.run("supervise", "@worker make the results table");
  await sup.agentStart();

  const letItRun = sup.tools.get("let_it_run")!;
  const first = await letItRun.execute("id", { reason: "job 23 at 438 of 600" }, undefined, undefined, sup.ctx);
  assert.match(first.content[0].text, /job 23 at 438 of 600/);

  const again = await letItRun.execute("id", { reason: "waiting for Evidence-b" }, undefined, undefined, sup.ctx);
  assert.equal(sup.aborts.length, 0, "a sign-off must not end the look in an error line");
  assert.match(again.content[0].text, /already recorded a verdict for the current worker view/);
  assert.equal(again.isError, undefined, "a repeat did nothing, and doing nothing is not an error");

  // A runaway is a count no sign-off explains.
  for (const _ of [3, 4, 5]) await letItRun.execute("id", { reason: "and again" }, undefined, undefined, sup.ctx);
  assert.equal(sup.aborts.length, 0, "five is still within reach of an ordinary answer");
  await letItRun.execute("id", { reason: "and again" }, undefined, undefined, sup.ctx);
  assert.equal(sup.aborts.length, 1, "the sixth is a loop, so it is cut");

  // The next view is a new look, and it gets a clean verdict of its own.
  await sup.agentStart();
  await sup.tools.get("steer")!.execute("id", { message: "read the log" }, undefined, undefined, sup.ctx);
  assert.equal(sup.aborts.length, 1, "the count is per look, not per pairing");
});

test("every verdict result names the way to end the turn, steer included", async () => {
  // Session 019ffa73 after the let_it_run wording was fixed at 11:05Z: 38 let_it_run looks ended
  // cleanly, but all 22 steers ran "CALL:steer -> Steered. That is instruction N -> CALL:let_it_run
  // -> Already recorded". The steer result named no exit, so a spare tool call was the only move
  // left. Any result that ends a look has to carry END_TURN.
  const sup = harness(SUPER_ID);
  await sup.start();
  await sup.run("supervise", "@worker make the results table");
  await sup.agentStart();

  const steered = await sup.tools.get("steer")!.execute("id", { message: "read the log" }, undefined, undefined, sup.ctx);
  assert.match(steered.content[0].text, /Supervisor instruction 1 was sent to worker session session-worker/);
  assert.match(steered.content[0].text, /no further tool call/, "a steer result must name the exit too");

  await sup.agentStart();
  const ran = await sup.tools.get("let_it_run")!.execute("id", { reason: "on track" }, undefined, undefined, sup.ctx);
  assert.match(ran.content[0].text, /no further tool call/);
});

test("an old view is dropped from context once its verdict is in, and the verdict is kept", async () => {
  // Session 019ffa73 over 16 hours: 80 views, 433k chars, and a context that went 37.9k -> 234.7k
  // with no compaction. The views are the bulk and they go stale within minutes; the verdict
  // reasons are 330 chars each and are what the supervisor actually needs to remember.
  const sup = harness(SUPER_ID);
  await sup.start();
  await sup.run("supervise", "@worker make the results table");

  const view = (n: number) => ({ role: "user", content: [{ type: "text", text: `The worker stopped.\n\njob ${n} running` }] });
  const judged = (n: number) => ({
    role: "assistant",
    content: [{ type: "thinking", thinking: `long private reasoning about job ${n}` }, { type: "toolCall", name: "let_it_run", arguments: { reason: `job ${n} on track` } }],
  });
  const verdict = (n: number) => ({ role: "toolResult", content: [{ type: "text", text: `Letting it run: job ${n} on track` }] });
  const history = [1, 2, 3, 4, 5].flatMap((n) => [view(n), judged(n), verdict(n)]);

  const sent = await sup.context([{ role: "user", content: [{ type: "text", text: "the brief" }] }, ...history]);
  const flat = JSON.stringify(sent);

  assert.equal(sent[0].content[0].text, "the brief", "the policy is not a view, so it stays");
  assert.match(sent[1].content[0].text, /dropped once you had judged it/, "view 1 is old, so it goes");
  assert.doesNotMatch(flat, /reasoning about job 1/, "old thinking is raw material, not memory");
  assert.doesNotMatch(flat, /reasoning about job 2/);
  assert.match(flat, /reasoning about job 5/, "the newest looks are untouched");

  for (const n of [1, 2, 3, 4, 5]) {
    assert.match(flat, new RegExp(`Letting it run: job ${n} on track`), `verdict ${n} is the memory, so it stays`);
    assert.match(flat, new RegExp(`"reason":"job ${n} on track"`), `and so is the reason it was called with`);
  }
  // A pruned look still reads as one exchange: view stub, the verdict call, its result.
  assert.equal(sent[2].content.length, 1, "only the thinking was taken out of the judged message");
  assert.equal(sent[2].content[0].type, "toolCall");
});

test("a worker session never has its context rewritten", async () => {
  // The pruner reads views, and only a supervisor has any. A worker running this extension must
  // see its own transcript untouched.
  const work = harness(WORKER_ID);
  await work.start();
  const messages = [{ role: "user", content: [{ type: "text", text: "The worker stopped.\n\nlooks like a view" }] }];
  const sent = await work.context([...messages, ...messages, ...messages, ...messages]);
  assert.equal(sent.length, 4);
  assert.ok(sent.every((m: any) => m.content[0].text.includes("looks like a view")), "nothing was dropped");
});

test("a view that arrives mid-answer starts a fresh look", async () => {
  // A view sent while the supervisor is busy is queued as a followUp, and a followUp runs inside
  // the agent loop already going, so agent_start does not fire again. Counting per agent run would
  // charge the second view for the first, and answer it "already recorded" for a view it has not
  // seen. The view branch resets the count, so the new view gets a verdict of its own.
  const sup = harness(SUPER_ID);
  await sup.start();
  await sup.run("supervise", "@worker make the results table");
  await sup.agentStart();

  const letItRun = sup.tools.get("let_it_run")!;
  await letItRun.execute("id", { reason: "no new turns since the last look" }, undefined, undefined, sup.ctx);

  // Half an hour later, still the same agent loop.
  sup.deliver(WORKER_ID, { t: "view", to: SUPER_ID, view: "job 24 Evidence-b queued", stopped: false });
  await new Promise((r) => setTimeout(r, 5));
  const fresh = await letItRun.execute("id", { reason: "waiting for job 24 Evidence-b to land" }, undefined, undefined, sup.ctx);
  assert.match(fresh.content[0].text, /waiting for job 24 Evidence-b to land/, "a new view, so a full verdict");
  assert.doesNotMatch(fresh.content[0].text, /Already recorded/);
  assert.equal(sup.aborts.length, 0);
});

test("a tool a worker cannot use never aborts its turn", async () => {
  // The verdict tools are guarded by role. The guard returns before the count, so a stray call in
  // an unpaired session can never reach the abort.
  const lone = harness(SUPER_ID);
  await lone.start();
  await lone.agentStart();
  for (const _ of [1, 2, 3]) {
    const refused = await lone.tools.get("let_it_run")!.execute("id", { reason: "x" }, undefined, undefined, lone.ctx);
    assert.equal(refused.isError, true);
  }
  assert.equal(lone.aborts.length, 0);
});

test("a resume onto a session that is gone drops the pairing and says so", async () => {
  // What wassname hit: resume a supervisor, it sits idle still claiming a pairing, prints nothing,
  // and refuses /supervise until you work out it wants /supervise stop. pairedId addresses a live
  // process, so restoring it out of a transcript is restoring an address, not a fact.
  const carried = [{ type: "custom", customType: STATE_ENTRY, data: { role: "supervisor", pairedId: "ghost-session", goal: "g", steerRounds: 3 } }];
  const resumed = harness(SUPER_ID, { entries: carried });
  await resumed.start();
  await new Promise((r) => setTimeout(r, 5));

  assert.ok(resumed.notices.some((n) => /ghost-se is gone.*Run \/supervise/.test(n)), resumed.notices.join(" | "));
  // And the refusal is gone with it, so /supervise works straight away.
  await resumed.run("supervise", "@worker do the thing");
  assert.ok(!resumed.notices.some((n) => /already paired/.test(n)), resumed.notices.join(" | "));
});

test("a resume onto a live worker keeps supervising, and takes the writers back off", async () => {
  const carried = [{ type: "custom", customType: STATE_ENTRY, data: { role: "supervisor", pairedId: WORKER_ID, goal: "g", steerRounds: 3 } }];
  const resumed = harness(SUPER_ID, { entries: carried });
  await resumed.start();
  await new Promise((r) => setTimeout(r, 5));

  assert.ok(resumed.notices.some((n) => /still supervising/.test(n)), resumed.notices.join(" | "));
  // Asking beats waiting. A supervisor back from a crash or a /reload holds a stale picture, and
  // only the worker makes views. Nobody should have to know that, so a restart is the whole cure.
  assert.deepEqual(resumed.published.filter((p) => p.t === "look"), [{ t: "look", to: WORKER_ID }]);
  // And the goal and the answer shape are said again, so a /reload is how a changed prompt lands.
  // Without it, fixing the wording needs a fresh pairing, which loses the count of steers.
  const anchor = resumed.contextMessages.at(-1)!.content;
  assert.match(anchor, /Supervising again/);
  assert.match(anchor, /<goal>\ng\n<\/goal>/);
  assert.match(anchor, /3 instructions so far/);
  assert.match(anchor, /one tool call: steer, done or let_it_run/);
  // The strip lives in the /supervise handler, which a resume never runs. Without this the
  // supervisor comes back with bash and edit in a directory the worker is writing to.
  const back = resumed.pi.getActiveTools();
  assert.deepEqual(back.filter((t: string) => ["bash", "edit", "write"].includes(t)), [], "no writers");
  assert.ok(back.includes("steer") && back.includes("worker_view"), "and it can still supervise");
});

test("state written before recentSteers existed still loads", () => {
  const old = [{ type: "custom", customType: STATE_ENTRY, data: { role: "supervisor", pairedId: "w", goal: "g", steerRounds: 4 } }];
  const restored = restoreState(old);
  assert.deepEqual(restored.recentSteers, []);
  assert.equal(restored.steerRounds, 4);
});

test("done unpairs the worker, so it stops publishing views", async () => {
  const worker = harness(WORKER_ID, { entries: [message("user", "hi")] });
  await worker.start();
  worker.deliver(SUPER_ID, { t: "pair", to: WORKER_ID, goal: "g" });
  // Long enough for the pairing view, which waits on a real ps call.
  await new Promise((r) => setTimeout(r, 300));
  const atPairing = worker.published.filter((p) => p.t === "view").length;
  assert.equal(atPairing, 1, "pairing publishes a first view, so the supervisor has something to read");

  await worker.settle();
  assert.equal(worker.published.filter((p) => p.t === "view").length, 2, "paired worker publishes");

  worker.deliver(SUPER_ID, { t: "done", to: WORKER_ID, reason: "results.md line 3" });
  await new Promise((r) => setTimeout(r, 5));

  await worker.settle();
  assert.equal(
    worker.published.filter((p) => p.t === "view").length,
    2,
    "after done the worker must not publish again",
  );
});

test("with no goal the supervisor cannot steer, it must ask the human", async () => {
  // Seen in a real run: started with no goal, the supervisor invented a task for the worker.
  const sup = harness(SUPER_ID);
  await sup.start();
  await sup.run("supervise", "@worker"); // a target and no goal

  const result = await sup.tools.get("steer")!.execute("id", { message: "do something" }, undefined, undefined, sup.ctx);
  assert.ok(result.isError, "steering with no goal must be refused");
  assert.match(result.content[0].text, /No goal is set/);
  assert.match(result.content[0].text, /set_goal/, "it must be told how to bind a goal it inferred");
});

test("set_goal binds an inferred goal, and steering then works", async () => {
  // The human likes goal inference at startup, but a silently invented goal is what went wrong in
  // his first run. So inference has to go through a tool that announces what it chose.
  const sup = harness(SUPER_ID);
  await sup.start();
  await sup.run("supervise", "worker"); // no goal

  const set = await sup.tools
    .get("set_goal")!
    .execute("id", { goal: "print the numbers 1 to 3" }, undefined, undefined, sup.ctx);
  assert.ok(!set.isError);
  assert.match(set.content[0].text, /Tell them in your reply/);
  assert.ok(sup.notices.some((n) => n.includes("print the numbers 1 to 3")), "the human must be told");
  // The worker owns the copy the view header is built from, so the goal has to go on the wire.
  // Without this line the whole test passed while set_goal kept the goal to itself.
  assert.deepEqual(
    sup.published.filter((p) => p.t === "goal"),
    [{ t: "goal", to: WORKER_ID, goal: "print the numbers 1 to 3" }],
  );

  const steer = await sup.tools.get("steer")!.execute("id", { message: "do it" }, undefined, undefined, sup.ctx);
  assert.ok(!steer.isError, `steering should work once a goal is set, got ${steer.content[0].text}`);
});

test("a goal given at pair time still allows steering", async () => {
  const sup = harness(SUPER_ID);
  await sup.start();
  await sup.run("supervise", "@worker make the results table");

  const result = await sup.tools.get("steer")!.execute("id", { message: "read the log" }, undefined, undefined, sup.ctx);
  assert.ok(!result.isError, `expected a steer to be allowed, got ${result.content[0].text}`);
});

test("done is refused while the worker has an unanswered tool call", async () => {
  // A settled worker whose subagent call has no result is still spending. "done" would be a lie.
  const sup = harness(SUPER_ID);
  await sup.start();
  await sup.run("supervise", "@worker finish the sweep");
  // Built by buildView, not hand written, so the guard cannot drift away from the view wording.
  const view = buildView({
    goal: "finish the sweep",
    status: "idle",
    entries: [{ type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: "x", name: "subagent", arguments: {} }] } }],
  });
  sup.deliver(WORKER_ID, { t: "view", to: SUPER_ID, view, stopped: true });
  await new Promise((r) => setTimeout(r, 5));

  const blocked = await sup.tools.get("done")!.execute("id", { reason: "looks finished" }, undefined, undefined, sup.ctx);
  assert.ok(blocked.isError, "done must be refused while a tool call has no result");
  assert.match(blocked.content[0].text, /still has work running \(subagent\)/);

  // Same guard, the other half: a subagent running as its own process leaves no unanswered call.
  const detached = buildView({ goal: "finish the sweep", status: "idle", entries: [message("assistant", "all done")], subagents: [4242] });
  sup.deliver(WORKER_ID, { t: "view", to: SUPER_ID, view: detached, stopped: true });
  await new Promise((r) => setTimeout(r, 5));
  const stillBusy = await sup.tools.get("done")!.execute("id", { reason: "looks finished" }, undefined, undefined, sup.ctx);
  assert.ok(stillBusy.isError, "done must be refused while a child pi process is running");
  assert.match(stillBusy.content[0].text, /still has work running \(4242\)/);
});

test("done is allowed once nothing is outstanding", async () => {
  const sup = harness(SUPER_ID);
  await sup.start();
  await sup.run("supervise", "@worker finish the sweep");
  const view = buildView({ goal: "finish the sweep", status: "idle", entries: [message("assistant", "all done")] });
  sup.deliver(WORKER_ID, { t: "view", to: SUPER_ID, view, stopped: true });
  await new Promise((r) => setTimeout(r, 5));

  const ok = await sup.tools.get("done")!.execute("id", { reason: "results.md line 3 says X" }, undefined, undefined, sup.ctx);
  assert.ok(!ok.isError, `expected done to be allowed, got ${ok.content[0].text}`);
});

test("steer refuses when the session is not supervising", async () => {
  const lone = harness(SUPER_ID);
  await lone.start();
  const result = await lone.tools.get("steer")!.execute("id", { message: "x" }, undefined, undefined, lone.ctx);
  assert.ok(result.isError);
});

test("a reworded repeat of an earlier instruction is sent, and named back to the supervisor", async () => {
  // Six remembered instructions do not stop a loop by themselves: rephrasing reads as new work.
  const sup = harness(SUPER_ID);
  await sup.start();
  await sup.run("supervise", "@worker g");
  const steer = sup.tools.get("steer")!;
  await steer.execute("id", { message: "Run the failing parser tests and fix the first failure" }, undefined, undefined, sup.ctx);
  const again = await steer.execute(
    "id",
    { message: "Please run those parser tests again and fix whatever failure comes first" },
    undefined,
    undefined,
    sup.ctx,
  );

  assert.ok(!again.isError, "a repeat is never refused, because sometimes it is the right call");
  assert.match(again.content[0].text, /says much the same as instruction 1/);
  assert.equal(sup.published.filter((p) => p.t === "directive").length, 2, "both were sent");

  const fresh = await steer.execute("id", { message: "Read docs/results.md and quote the table" }, undefined, undefined, sup.ctx);
  assert.doesNotMatch(fresh.content[0].text, /says much the same/);
});

test("overlap scores rewording high and a different instruction low", () => {
  assert.ok(overlap("Run the failing parser tests and fix the first failure", "Please run those parser tests again and fix whatever failure comes first") > 0.4);
  assert.ok(overlap("run the parser tests", "write the results table to docs") < 0.2);
  // The limit worth knowing: a paraphrase that shares no vocabulary is invisible to this.
  assert.ok(overlap("run the test suite and fix what breaks", "independently validate the implementation") < 0.1);
});

test("the view of the old worker cannot be used to judge the new one", async () => {
  const sup = harness(SUPER_ID);
  await sup.start();
  await sup.run("supervise", "@worker g");
  sup.deliver(WORKER_ID, { t: "view", to: SUPER_ID, view: "# Goal: old worker\n", stopped: true });
  await new Promise((r) => setTimeout(r, 5));
  await sup.run("supervise", "stop");
  await sup.run("supervise", "@worker g2");

  const seen = await sup.tools.get("worker_view")!.execute("id", {}, undefined, undefined, sup.ctx);
  assert.doesNotMatch(seen.content[0].text, /old worker/);
});

test("with one other session here, /supervise needs no target and the whole line is the goal", async () => {
  const sup = harness(SUPER_ID);
  await sup.start();
  await sup.run("supervise", "make the results table");

  const pair = sup.published.find((p) => p.t === "pair");
  assert.equal(pair.to, WORKER_ID, "the only other session in this directory is the worker");
  assert.equal(pair.goal, "make the results table", "no word of that is a target");
});

test("naming the worker still works, and the rest of the line is the goal", async () => {
  const sup = harness(SUPER_ID);
  await sup.start();
  await sup.run("supervise", "@worker make the results table");
  assert.deepEqual(sup.published.find((p) => p.t === "pair"), {
    t: "pair",
    to: WORKER_ID,
    goal: "make the results table",
  });
});

test("with two free sessions here, /supervise asks which one, and pairs with the choice", async () => {
  const sup = harness(SUPER_ID, {
    extraSessions: [{ id: "session-third", pid: 999, name: "other", cwd: process.cwd() }],
    freeSessions: [WORKER_ID, "session-third"],
    pick: 1,
  });
  await sup.start();
  await sup.run("supervise", "make the results table");

  assert.equal(sup.selects.length, 1, "guessing between two workers is worse than asking");
  assert.match(sup.selects[0].title, /make the results table/, "the goal, so you know what you are picking for");
  assert.deepEqual(sup.selects[0].options.length, 2);
  assert.deepEqual(
    sup.published.filter((p) => p.t === "pair"),
    [{ t: "pair", to: "session-third", goal: "make the results table" }],
  );
});

test("a goal that is a path is read from the file, so it is not pasted every run", async () => {
  // The goal is the thing the work is graded against, and pasting it into a prompt each run is how
  // the copy you steer by drifts from the copy you grade by.
  const dir = mkdtempSync(join(tmpdir(), "supervise-goal-"));
  const path = join(dir, "GOAL.md");
  const goal = "**GOAL - preference learning.**\nEvidence a) a 256 token trace.\nEvidence b) NLL beats the hold.";
  writeFileSync(path, `${goal}\n`);

  const sup = harness(SUPER_ID);
  await sup.start();
  await sup.run("supervise", `@worker ${path}`);
  assert.deepEqual(sup.published.filter((p) => p.t === "pair"), [{ t: "pair", to: WORKER_ID, goal }]);

  // A path that is not there stops the pairing, rather than setting the goal to the path itself.
  const typo = harness(SUPER_ID);
  await typo.start();
  await assert.rejects(() => typo.run("supervise", `@worker ${join(dir, "NOPE.md")}`), /NOPE\.md/);
  assert.equal(typo.published.filter((p) => p.t === "pair").length, 0);

  // A goal with spaces is still a goal, even when a word in it has a dot.
  const plain = harness(SUPER_ID);
  await plain.start();
  await plain.run("supervise", "@worker make results.md say what won");
  assert.equal(plain.published.filter((p) => p.t === "pair")[0].goal, "make results.md say what won");
});

test("a long goal is one short line above the picker, and reaches the worker whole", async () => {
  // wassname's real goals are paragraphs of acceptance evidence. The whole thing as a picker title
  // is a wall of text to read past, and he already knows it: he just typed it.
  const goal = `**GOAL - preference learning and extrapolation.**
Learn a user's preferences online from interaction and extrapolate them: an
explicit, addressable latent user state that predicts what this user wants.`;
  const sup = harness(SUPER_ID, {
    extraSessions: [{ id: "session-third", pid: 999, name: "other", cwd: process.cwd() }],
    freeSessions: [WORKER_ID, "session-third"],
    pick: 0,
  });
  await sup.start();
  await sup.run("supervise", goal);

  const title = sup.selects[0].title;
  assert.ok(title.length < 100, `the title is a label, not the goal: ${title}`);
  assert.match(title, /\*\*GOAL - preference learning and extrapolation\.\*\*/, "enough to tell two goals apart");
  assert.ok(!title.includes("\n"), "one line");
  // Cut for display only. What the worker judges itself against is never cut.
  assert.equal(sup.published.filter((p) => p.t === "pair")[0].goal, goal);
});

test("a session that stayed quiet is still on the list, because 0 free is a dead end", async () => {
  // Live 2026-08-13: five child runs answered nothing and the worker had not been reloaded, so a
  // roll call alone left wassname with "0 free sessions" and no way through.
  const sup = harness(SUPER_ID, {
    extraSessions: [
      { id: "019ff8ac-1", pid: 1, name: "general-purpose#f818354d", cwd: process.cwd() },
      { id: "019ff8ac-2", pid: 2, name: "general-purpose#18c778eb", cwd: process.cwd() },
    ],
    freeSessions: [],
    pick: 0,
  });
  await sup.start();
  await sup.run("supervise", "make the results table");

  assert.equal(sup.selects[0].options.length, 3, "everything here, so nothing is hidden");
  assert.match(sup.selects[0].options[0], /no answer/, "and marked, so the odd ones look odd");
  assert.equal(sup.published.filter((p) => p.t === "pair").length, 1, "the pick is honoured");
});

test("a cancelled picker pairs with nothing", async () => {
  const sup = harness(SUPER_ID, {
    extraSessions: [{ id: "session-third", pid: 999, name: "other", cwd: process.cwd() }],
    freeSessions: [WORKER_ID, "session-third"],
  });
  await sup.start();
  await sup.run("supervise", "make the results table");

  assert.deepEqual(sup.published.filter((p) => p.t === "pair"), []);
});

test("supervising takes the writing tools away, and stopping gives them back", async () => {
  // The supervisor shares a working directory with the worker, so a supervisor that can write is a
  // second agent editing the same files.
  const sup = harness(SUPER_ID);
  await sup.start();
  const before = sup.pi.getActiveTools();
  await sup.run("supervise", "g");

  const during = sup.pi.getActiveTools();
  assert.deepEqual(
    during,
    ["read", "grep", "list", "worker_view", "set_goal", "steer", "let_it_run", "done"],
    "no bash, no edit, no write, and the supervisor tools appear",
  );
  await sup.run("supervise", "stop");
  assert.deepEqual(sup.pi.getActiveTools(), before, "and back to what you had");
});

test("stopping gives back the writers without undoing another extension's tools", async () => {
  // pi-context-prune adds context_prune and pi-telegram suspends its own tools, both by reading the
  // active list and changing one name (pi-context-prune/index.ts:376-388). Restoring a whole list
  // saved hours earlier would silently undo whatever they decided in between.
  const sup = harness(SUPER_ID);
  await sup.start();
  await sup.run("supervise", "g");
  sup.pi.setActiveTools([...sup.pi.getActiveTools(), "context_prune"]);

  await sup.run("supervise", "stop");
  const after = sup.pi.getActiveTools();
  assert.ok(after.includes("context_prune"), "the other extension's tool is still there");
  assert.ok(after.includes("bash") && after.includes("edit") && after.includes("write"), "and the writers are back");
});

test("a first word that names no session is refused, rather than folded into the goal", async () => {
  // wassname typed "/supervise LUCID <goal>" when the session was named LUCID_worker. The old code
  // matched nothing, fell back to the only session here, and set the goal to "LUCID <goal>".
  const sup = harness(SUPER_ID);
  await sup.start();
  await sup.run("supervise", "@LUCID make the results table");

  assert.deepEqual(sup.published, [], "no pairing on a target that matches nothing");
  assert.match(sup.notices.join("\n"), /0 sessions match @LUCID/);
});

test("a goal with spaces needs no target, and @name takes the rest of the line as the goal", async () => {
  const plain = harness(SUPER_ID);
  await plain.start();
  await plain.run("supervise", "make the results table and quote it");
  assert.equal(plain.published.find((p) => p.t === "pair").goal, "make the results table and quote it");

  const named = harness(SUPER_ID);
  await named.start();
  await named.run("supervise", "@worker make the results table and quote it");
  assert.deepEqual(named.published.find((p) => p.t === "pair"), {
    t: "pair",
    to: WORKER_ID,
    goal: "make the results table and quote it",
  });
});

test("the brief starts no turn, so there is no answer before the first view", async () => {
  // The whole loop: a user message is a turn, and a supervisor holding verdict tools with no view
  // to read still answers. It called let_it_run 98 times on 2026-08-13, and twice more after the
  // brief asked it not to. The brief is context now, and the view is what wakes it.
  const sup = harness(SUPER_ID);
  await sup.start();
  await sup.run("supervise", "@worker make the results table");

  assert.deepEqual(sup.userMessages, [], "nothing may start a supervisor turn before a view");
  const brief = sup.contextMessages.at(-1)!;
  assert.match(brief.content, /You are now supervising the pi session "worker"/);
  assert.deepEqual(brief.options, { triggerTurn: false });

  // And the view is a user message, because that one is meant to be answered.
  sup.deliver(WORKER_ID, { t: "view", to: SUPER_ID, view: "worker view", stopped: true });
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(sup.userMessages.length, 1);
  assert.match(sup.userMessages[0].content, /worker view/);
});

test("/supervise goal changes the goal without breaking the pairing", async () => {
  // The only other way is /supervise stop and a fresh pairing, which throws away the steer count.
  const sup = harness(SUPER_ID);
  await sup.start();
  await sup.run("supervise", "@worker make the table");
  await sup.tools.get("steer")!.execute("id", { message: "run the suite" }, undefined, undefined, sup.ctx);

  await sup.run("supervise", "goal quote the evidence file instead");

  assert.deepEqual(sup.published.filter((p) => p.t === "goal"), [
    { t: "goal", to: WORKER_ID, goal: "quote the evidence file instead" },
  ], "the worker holds the copy every view header is built from");
  assert.ok(sup.published.some((p) => p.t === "look"), "and a fresh view follows, so it judges now");
  assert.match(sup.contextMessages.at(-1)!.content, /changed the goal[\s\S]*quote the evidence file instead/);
  assert.match(sup.status.get("intercom-supervisor")!, /watching 1/, "the steer count survives");
});

test("the footer says which side of a pairing this session is, and clears when it ends", async () => {
  // The notice at pairing scrolls away, and then a paired session looks like any other prompt.
  // wassname could not tell that a supervisor had stopped supervising.
  const sup = harness(SUPER_ID);
  await sup.start();
  assert.equal(sup.status.get("intercom-supervisor"), undefined, "nothing to say when unpaired");

  await sup.run("supervise", "make the table");
  assert.match(sup.status.get("intercom-supervisor")!, /watching 0/);
  await sup.tools.get("steer")!.execute("id", { message: "run the suite" }, undefined, undefined, sup.ctx);
  assert.match(sup.status.get("intercom-supervisor")!, /watching 1/);

  // A status set during session_start is lost, because the footer has not mounted yet. Observed
  // 2026-08-12: a resumed supervisor showed nothing in wassname's footer. So set it every turn.
  sup.status.clear();
  await sup.turnStart();
  assert.match(sup.status.get("intercom-supervisor")!, /watching 1/, "and again each turn");

  await sup.run("supervise", "stop");
  assert.equal(sup.status.get("intercom-supervisor"), undefined);

  const worker = harness(WORKER_ID);
  await worker.start();
  worker.deliver(SUPER_ID, { t: "pair", to: WORKER_ID, goal: "g" });
  await new Promise((r) => setTimeout(r, 5));
  assert.match(worker.status.get("intercom-supervisor")!, /watched/, "the worker says so too");
});

test("a session that is not supervising never sees the supervisor tools", async () => {
  // Observed 2026-08-12: a worker on an ordinary coding task read its own tool list, reasoned
  // "these are supervisor tools ... so I might be the supervisor for a worker session", and spent
  // twelve turns on that before doing any work.
  const worker = harness(WORKER_ID, { entries: [message("user", "do the thing")] });
  await worker.start();
  assert.deepEqual(
    worker.pi.getActiveTools().filter((t: string) => ["worker_view", "set_goal", "steer", "let_it_run", "done"].includes(t)),
    [],
    "an unpaired session is not offered any of them",
  );

  worker.deliver(SUPER_ID, { t: "pair", to: WORKER_ID, goal: "g" });
  await new Promise((r) => setTimeout(r, 5));
  assert.ok(!worker.pi.getActiveTools().includes("steer"), "and a paired worker is not either");
});

test("worker_view refuses when there is no worker, rather than implying a pairing", async () => {
  // The old answer, "the worker has not stopped since pairing", told a session with no pairing at
  // all that it had one.
  const worker = harness(WORKER_ID);
  await worker.start();
  const seen = await worker.tools.get("worker_view")!.execute("id", {}, undefined, undefined, worker.ctx);
  assert.equal(seen.isError, true);
  assert.match(seen.content[0].text, /Not supervising/);
  assert.doesNotMatch(seen.content[0].text, /since pairing/);
});

test("the view names the worker's model and how full its context is", async () => {
  // A supervisor steering a small model should give smaller steps, and a worker near the top of
  // its context is about to compact and lose detail. Both come off the intercom presence record.
  const worker = harness(WORKER_ID, { entries: [message("user", "do the thing")] });
  await worker.start();
  worker.deliver(SUPER_ID, { t: "pair", to: WORKER_ID, goal: "g" });
  await new Promise((r) => setTimeout(r, 5));
  await worker.settle();

  const view = worker.published.find((p) => p.t === "view");
  assert.match(view.view, /model: test\/tiny, 12% of its context used/);
});

test("supervising a second session is refused while the first is still paired", async () => {
  const sup = harness(SUPER_ID);
  await sup.start();
  await sup.run("supervise", "@worker g");
  const before = sup.published.length;
  await sup.run("supervise", "@worker other goal");

  assert.equal(sup.published.length, before, "no second pair goes out");
  assert.match(sup.notices.join("\n"), /already paired/);
});

test("the supervisor gets a look at a working worker every half hour, without being asked", async (t) => {
  // A human supervising wanders past now and then. Waiting for the worker to stop is the thing
  // this is meant to replace.
  t.mock.timers.enable({ apis: ["setInterval", "Date"] });
  const worker = harness(WORKER_ID, { entries: [message("user", "do the thing")], isIdle: false });
  await worker.start();
  worker.deliver(SUPER_ID, { t: "pair", to: WORKER_ID, goal: "g" });
  await new Promise((r) => setTimeout(r, 300)); // pairing publishes a view, and that runs ps
  const atPairing = worker.published.filter((p) => p.t === "view").length;

  await worker.turnStart();
  t.mock.timers.tick(1_500_000);
  assert.equal(worker.published.filter((p) => p.t === "view").length, atPairing, "25 minutes in is too early");

  t.mock.timers.tick(400_000);
  await new Promise((r) => setTimeout(r, 300)); // the look runs ps, so give the real clock a moment
  const views = worker.published.filter((p) => p.t === "view").slice(atPairing);
  assert.equal(views.length, 1, "past half an hour the supervisor gets a look");
  assert.equal(views[0].stopped, false, "this worker is mid-turn, so it is a check in");
  assert.match(views[0].view, /status: working, routine check in, no new turn for \d+[smh]/);
  // A look that forgets the subagent line reports "none" and unblocks done while one is running.
  assert.match(views[0].view, /^child pi processes still running: /m);

  await worker.settle();
  const after = worker.published.filter((p) => p.t === "view").length;
  t.mock.timers.tick(600_000);
  await new Promise((r) => setTimeout(r, 300)); // let any look that did start finish, so it counts
  assert.equal(worker.published.filter((p) => p.t === "view").length, after, "ten minutes is still too early");
});

test("a human message in the worker session is not a reason to stand back", async () => {
  // The reason the supervisor gave for the 2h27m silence was "human is actively directing".
  // wassname: "err no if I send a message it doesn't mean the supervisor should stop, I will stop
  // them if I need to". So this must be said in both places: the brief, and the let_it_run
  // description, which is the only one of the two that survives a supervisor compaction.
  const sup = harness(SUPER_ID);
  await sup.start();
  await sup.run("supervise", "@worker make the results table");

  assert.match(sup.contextMessages.at(-1)!.content, /not a handover, and it is not a reason to stand back/);
  assert.match(sup.tools.get("let_it_run")!.description, /A human message does not end supervision/);

  // And on the view that carries a stopped worker, where the excuse actually got used.
  sup.deliver(WORKER_ID, { t: "view", to: SUPER_ID, view: "worker view", stopped: true });
  await new Promise((r) => setTimeout(r, 5));
  assert.match(sup.userMessages[0].content, /human being present does not count as somebody driving it/);
});

test("letting a stopped worker run says plainly that the worker stays stopped", async () => {
  // The other half of the two and a half hour silence. The supervisor answered let_it_run to a
  // stopped worker while saying it was "waiting for the worker to re-queue". Nothing was going to
  // re-queue. The result now says so, rather than the model having to know it.
  const sup = harness(SUPER_ID);
  await sup.start();
  await sup.run("supervise", "@worker make the results table");
  const letItRun = sup.tools.get("let_it_run")!;

  sup.deliver(WORKER_ID, { t: "view", to: SUPER_ID, view: "job 12 at step 40", stopped: false });
  await new Promise((r) => setTimeout(r, 5));
  const working = await letItRun.execute("id", { reason: "on track" }, undefined, undefined, sup.ctx);
  assert.doesNotMatch(working.content[0].text, /does not start again by itself/, "a working worker needs no warning");

  sup.deliver(WORKER_ID, { t: "view", to: SUPER_ID, view: "job 12 finished", stopped: true });
  await new Promise((r) => setTimeout(r, 5));
  const stopped = await letItRun.execute("id", { reason: "waiting for the worker to re-queue" }, undefined, undefined, sup.ctx);
  assert.match(stopped.content[0].text, /A stopped worker does not resume\s+without a new user or supervisor message/);
  assert.match(stopped.content[0].text, /send a concrete continuation\s+instruction/, "the warning names the action that can move the worker");
});

test("a stopped worker is looked at again, so let_it_run cannot silence the pairing", async (t) => {
  // Session 019ffa73, 2026-08-14. The worker stopped at 02:02:18Z. The supervisor saw the stop and
  // answered let_it_run, "waiting for the worker to re-queue in the main group". Nothing then woke
  // either side for two and a half hours, until wassname typed "why stop". let_it_run means do
  // nothing, and doing nothing is exactly what a stopped worker does.
  t.mock.timers.enable({ apis: ["setInterval", "Date"] });
  const worker = harness(WORKER_ID, { entries: [message("user", "do the thing")], isIdle: true });
  await worker.start();
  worker.deliver(SUPER_ID, { t: "pair", to: WORKER_ID, goal: "g" });
  await new Promise((r) => setTimeout(r, 300));

  await worker.turnStart();
  await worker.settle(); // the worker stops, and the supervisor answers let_it_run: no reply comes back
  const afterStop = worker.published.filter((p) => p.t === "view").length;

  t.mock.timers.tick(1_900_000);
  await new Promise((r) => setTimeout(r, 300));
  const views = worker.published.filter((p) => p.t === "view").slice(afterStop);
  assert.equal(views.length, 1, "half an hour later the supervisor is asked about the stopped worker again");
  assert.equal(views[0].stopped, true, "and is told the worker is still stopped");
  // The status line carries the one number that says how bad the silence is. wassname's ask after
  // the live incident: "be clear there have been no turns for this long, is it stuck".
  assert.match(views[0].view, /status: stopped, looked at again, no new turn for \d+[smh]/);

  // Unchanged is not a reason to stay quiet here: an unchanged stopped worker is the thing to fix.
  t.mock.timers.tick(1_900_000);
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(worker.published.filter((p) => p.t === "view").length, afterStop + 2, "and again after that");
});

test("a worker that pairs at the prompt and never takes a turn is still watched", async (t) => {
  // The same silence reached from the other end. The timer used to start only on turn_start, so a
  // worker paired or reloaded while sitting at the prompt had no timer at all. Seen live on
  // 2026-08-14: both sessions reloaded, the supervisor asked for a view, and nothing came back.
  t.mock.timers.enable({ apis: ["setInterval", "Date"] });
  const worker = harness(WORKER_ID, { entries: [message("user", "do the thing")], isIdle: true });
  await worker.start();
  worker.deliver(SUPER_ID, { t: "pair", to: WORKER_ID, goal: "g" });
  await new Promise((r) => setTimeout(r, 300));
  const atPairing = worker.published.filter((p) => p.t === "view").length;

  // No turnStart and no settle: this worker has done nothing since it was paired.
  t.mock.timers.tick(1_900_000);
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(
    worker.published.filter((p) => p.t === "view").length,
    atPairing + 1,
    "half an hour after pairing the supervisor is shown the worker, with no turn having happened",
  );
});

test("a worker that reloads at the prompt starts watching itself again", async (t) => {
  // rejoinOrDrop is the only thing that runs on a reloaded worker that then sits idle. Without the
  // timer start there, /reload silently ends the watching, which is the worst place to lose it:
  // /reload is how a fix reaches a running pairing.
  t.mock.timers.enable({ apis: ["setInterval", "Date"] });
  const carried = [{ type: "custom", customType: STATE_ENTRY, data: { role: "worker", pairedId: SUPER_ID, goal: "g", steerRounds: 0 } }];
  const worker = harness(WORKER_ID, { entries: [...carried, message("user", "do the thing")], isIdle: true });
  await worker.start();
  await new Promise((r) => setTimeout(r, 300));
  const atReload = worker.published.filter((p) => p.t === "view").length;

  t.mock.timers.tick(1_900_000);
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(
    worker.published.filter((p) => p.t === "view").length,
    atReload + 1,
    "half an hour after the reload the supervisor is shown the idle worker",
  );
});

test("a timer look at a worker that has not moved is not sent, until it has been skipped three times", async (t) => {
  // Session 019ffa73: 13 of 92 verdicts were the supervisor reading a view it had already read,
  // e.g. "check-in with no new turns; worker still working, no evidence of trouble". An identical
  // view carries no new information, so asking for a verdict on one only spends a model call.
  t.mock.timers.enable({ apis: ["setInterval", "Date"] });
  const entries = [message("user", "do the thing")];
  const worker = harness(WORKER_ID, { entries, isIdle: false });
  await worker.start();
  worker.deliver(SUPER_ID, { t: "pair", to: WORKER_ID, goal: "g" });
  await new Promise((r) => setTimeout(r, 300));
  await worker.turnStart();

  const look = async () => {
    t.mock.timers.tick(1_900_000);
    await new Promise((r) => setTimeout(r, 300)); // the look runs ps on the real clock
    return worker.published.filter((p) => p.t === "view").length;
  };

  const first = await look();
  assert.equal(await look(), first, "nothing changed, so the supervisor is not woken");
  assert.equal(await look(), first, "still nothing");
  assert.equal(await look(), first, "three skipped is the limit");
  assert.equal(await look(), first + 1, "a worker that has not moved for hours is worth seeing");

  // The count resets, so the next unchanged look is skipped again rather than sent.
  assert.equal(await look(), first + 1, "skipping starts over after the forced look");

  entries.push(message("assistant", "I read the log and queued job 12."));
  assert.equal(await look(), first + 2, "a real new turn always goes out");
});

test("the worker counts reviews in a row where nothing changed", async () => {
  const entries = [message("user", "do the thing")];
  const worker = harness(WORKER_ID, { entries });
  await worker.start();
  worker.deliver(SUPER_ID, { t: "pair", to: WORKER_ID, goal: "g" });
  await new Promise((r) => setTimeout(r, 300)); // the pairing view runs ps

  await worker.settle();
  entries.push(message("assistant", "I will get to that shortly."));
  await worker.settle();
  entries.push(message("assistant", "Yes, I agree that is the right approach."));
  await worker.settle();

  // The pairing view is not a review, so it is dropped here and does not count.
  const views = worker.published.filter((p) => p.t === "view").slice(1);
  assert.doesNotMatch(views[0].view, /reviews in a row/, "the first review has nothing to compare against");
  assert.match(views[2].view, /no new file or commit for 2 reviews in a row/);

  entries.push({
    type: "message",
    message: { role: "assistant", content: [{ type: "toolCall", id: "w", name: "write", arguments: { path: "results.md" } }] },
  });
  await worker.settle();
  const after = worker.published.filter((p) => p.t === "view").at(-1)!;
  assert.doesNotMatch(after.view, /reviews in a row/, "real work must clear the count, not just pause it");
});

test("an unacknowledged pair gives up, and a takeover cancels that timer", async (t) => {
  // A supervisor waiting for an acknowledgment can itself be taken over as a worker. The timer it
  // armed then fired against the new partner and blamed a session no longer involved.
  t.mock.timers.enable({ apis: ["setTimeout"] });

  // Named with @, so /supervise skips the roll call. Its wait is a real setTimeout, which the
  // mocked clock here would never fire, and the command would hang instead of pairing.
  const lonely = harness(SUPER_ID);
  await lonely.start();
  await lonely.run("supervise", "@worker"); // nobody will acknowledge
  t.mock.timers.tick(20_000);
  assert.deepEqual(lonely.published.at(-1), { t: "unpair", to: WORKER_ID }, "it must let the worker go");
  assert.match(lonely.notices.join("\n"), /never acknowledged/);

  const takenOver = harness(WORKER_ID);
  await takenOver.start();
  await takenOver.run("supervise", "@supervisor"); // arms a timer nobody will answer
  takenOver.deliver("session-third", { t: "pair", to: WORKER_ID, goal: "g" });
  await Promise.resolve();
  const sent = takenOver.published.length;
  t.mock.timers.tick(20_000);
  assert.equal(takenOver.published.length, sent, "no unpair may go out after the takeover");

  takenOver.deliver("session-third", { t: "directive", to: WORKER_ID, text: "carry on" });
  await Promise.resolve();
  assert.deepEqual(
    takenOver.userMessages.filter((m) => m.content.startsWith("[supervisor]")).map((m) => m.content),
    ["[supervisor] carry on"],
    "the pairing must still work",
  );
});

test("duplicate standalone Intercom registries are diagnosed and cannot bootstrap a plan", async () => {
  const h = harness(WORKER_ID);
  await h.start();
  h.pi.events.emit(INTERCOM_EXTENSION_REGISTRY_READY_EVENT, { version: 1 });
  await assert.rejects(new Promise((resolve, reject) => h.pi.events.emit("pi-supervise:plan:v1", { version: 1, method: "status", resolve, reject })), /Duplicate standalone pi-intercom/);
  assert.ok(h.notices.some(note => note.includes("Remove the old companion")));
});
