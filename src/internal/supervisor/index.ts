/**
 * intercom-supervisor: a supervisor pi session watches a worker pi session and steers it.
 *
 * Internal to pi-goals. The package loads this in both sessions; Ready creates the supervisor.
 *
 * Wire: the pi-intercom extension channel carries data without starting a turn, so each side
 * triggers its own turn locally with pi.sendUserMessage. The broker stamps fromSessionId from its
 * own registry, so pairing on that ID cannot be forged by a payload.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type {
  IntercomExtensionChannel,
  IntercomExtensionEvent,
} from "pi-intercom/extension-api.ts";
import { Type } from "typebox";
import { backgroundState } from "./background.js";
import { type GoalDecision, type GoalReview, PLAN_API_EVENT, type PlanApiRequest, type PlanBinding, pendingReply, planHash, planText, validBinding } from "./plan-api.js";

/**
 * Public event names from the bundled pi-intercom/extension-api.ts protocol. The channel types
 * are imported without loading a second transport runtime.
 */
const INTERCOM_EXTENSION_REGISTER_EVENT = "intercom:extension-register";
const INTERCOM_EXTENSION_REGISTRY_READY_EVENT = "intercom:extension-registry-ready";
export const PROGRAMMATIC_PAIR_EVENT = "pi-supervise:pair:v1";
export const WORKER_STATE_EVENT = "pi-supervise:worker-state:v1";
export const WORKER_PAIRED_EVENT = "pi-supervise:worker-paired:v1";
export const API_READY_EVENT = "pi-supervise:api-ready:v1";

export interface ProgrammaticPairRequest {
  version: 1;
  workerIntercomId: string;
  goal: string;
  resolve(): void;
  reject(error: Error): void;
}

import {
  BRIEF,
  DONE_BLOCKED,
  GOAL_CHANGED,
  isViewText,
  LET_IT_RUN_ACK,
  LET_IT_RUN_AGAIN,
  loadSupervisorPrompt,
  NO_GOAL,
  REANCHOR,
  REVIEW_NUDGE,
  STEER_ACK,
  TOOL_DONE,
  TOOL_LET_IT_RUN,
  TOOL_STEER,
  VIEW_PRUNED,
} from "./prompts.js";
import {
  EMPTY_STATE,
  isWire,
  NAMESPACE,
  OVERLAP_WARN,
  overlap,
  restoreState,
  STATE_ENTRY,
  STEER_MEMORY,
  type SuperviseState,
  type Wire,
} from "./protocol.js";
import { childPiProcesses } from "./subagents.js";
import { age, buildView, progressKey, sinceLastTurn, turnsSince } from "./view.js";

/**
 * The worker's model and context use, for the view header, from its own broker presence record.
 *
 * contextPct is missing right after a compaction and on a session with no model selected, so it is
 * left out rather than printed as 0, which would read as an empty context.
 */
function workerModel(info: { model: string; contextPct?: number }): string {
  return info.contextPct === undefined ? info.model : `${info.model}, ${info.contextPct}% of its context used`;
}

/**
 * A goal that is one word containing a slash or a dot is a path, and the file is the goal.
 *
 * A goal worth grading against runs to paragraphs of acceptance evidence, and retyping it into a
 * prompt each run is how the copy you steer by drifts from the copy you grade by. A missing file
 * throws, with the path in the message.
 */
function readGoal(cwd: string, goal: string): string {
  if (!/^\S+$/.test(goal) || !/[/.]/.test(goal)) return goal;
  return readFileSync(resolve(cwd, goal), "utf8").trim();
}

/** A goal on one line, for a notice or a picker title. The goal itself is never cut. */
function firstLine(goal: string, width = 60): string {
  const line = goal.trim().split("\n")[0].trim();
  return line.length > width ? `${line.slice(0, width)}...` : line;
}

/**
 * The footer line, kept to two words plus a glyph.
 *
 * pi-powerline-footer appends extension statuses to the end of its own line, so this costs footer
 * width for the whole session. The oracle's status can afford to be long because it shows only
 * while a run is going. The paired session id is left out: it helps only with three sessions open,
 * and you already know which terminal you are looking at.
 */
const STATUS_ID = "intercom-supervisor";
const EYE = "\u{1F441}";

/** How long the supervisor waits for the worker to acknowledge a pair before giving up on it. */
const PAIR_ACK_TIMEOUT_MS = 10_000;

/**
 * How long /supervise waits for the roll call. One round trip over a local unix socket, so this is
 * mostly slack for a session busy in the middle of a turn.
 */
const ROLL_CALL_MS = 500;

/**
 * Set in every session pi-subagents starts (pi-args.ts:622, unconditional), so a child run can
 * recognise itself and stay out of the roll call.
 */
const SUBAGENT_ENV = "PI_SUBAGENT_CHILD";

/**
 * How often the supervisor looks at a worker that is still working. It also looks when the worker
 * stops, whatever this is set to, so a short turn is never missed.
 *
 * One supervisor turn per interval per busy worker, so this is the token bill of watching. Half an
 * hour is the wandering-past rate a human keeps; shorten it if you want a closer eye.
 */
const WATCH_INTERVAL_MS = 1_800_000;

/** How often the timer checks whether a look is due. Sets how late a look can be, nothing else. */
const WATCH_POLL_MS = 30_000;

/** A multi-line goal is reinserted before this many supervisor reviews can pass without it. */
const GOAL_REVIEW_INTERVAL = 5;

/** How many identical timer looks are skipped before the supervisor is shown one anyway. */
const LOOKS_SKIPPED_MAX = 3;

/**
 * A view without the one line that changes on its own.
 *
 * The status line carries seconds into the turn, so two views of a worker that has done nothing are
 * never byte-identical. Everything else in a view comes from the worker's branch.
 */
const bodyOf = (view: string) => view.split("\n").filter((line) => !line.startsWith("status: ")).join("\n");

/**
 * Tools taken away from a supervising session, and given back when supervision ends.
 *
 * The supervisor shares a working directory with the worker, so a supervisor that can write is a
 * second agent editing the same files at the same time. It keeps read, grep and the rest, because
 * checking a claim against a file is its job. If it wants a command run, it steers the worker.
 *
 * A deny list, not an allow list: a read tool named something unexpected stays available rather
 * than silently disappearing. The kept list is printed, so a writer this misses is visible.
 */
const WRITER_TOOLS = new Set([
  "bash", "edit", "write", "multi_edit", "multiedit", "apply_patch", "notebook_edit",
  "edit_file", "write_file", "quick_edit", "target_edit",
]);

/**
 * The tools only a supervisor should have. Hidden in every session that is not supervising.
 *
 * Both sessions load this extension and registration happens at load, so without this a plain
 * worker is offered worker_view, steer, let_it_run and done. Observed 2026-08-12: a worker given an
 * ordinary coding task spent twelve turns reasoning "these are supervisor tools ... so I might be
 * the supervisor for a worker session", called worker_view, and read "the worker has not stopped
 * since pairing" as proof of a pairing it never had.
 */
const SUPERVISOR_TOOLS = ["worker_view", "set_goal", "steer", "let_it_run", "done", "review_goal"];

export default function (pi: any, modelReady: () => boolean = () => true) {
  let duplicateIntercom = false;
  let channel: IntercomExtensionChannel | undefined;
  let intercomRegistered = false;
  let sessionInitialized = false;
  let state: SuperviseState = { ...EMPTY_STATE };
  let latestView = "";
  let modelTurns = 0;
  let publishing = false;
  let settledCheck = false;
  let stopping = false;
  let bootstrapPending = false;
  let compacting: Promise<void> | undefined;
  let pairingGeneration = 0;
  let attached: ReturnType<typeof pendingReply<unknown>> | undefined;
  let outgoingReview: (ReturnType<typeof pendingReply<GoalDecision>> & { review: GoalReview }) | undefined;
  let incomingReview: GoalReview | undefined;
  /** Supervisor side: whether the worker was stopped in that view, which changes what let_it_run costs. */
  let workerStopped = false;
  let ctx: any;
  let ownId = "";
  /** Supervisor side: review views since the full multi-line goal was last inserted. */
  let reviewsSinceGoal = 0;
  /** Worker side: the last progressKey, and how many reviews in a row have matched it. */
  let lastProgress = "";
  let staleReviews = 0;
  /** Worker side: how many turns the supervisor has already been sent, so views carry only the new ones. */
  let sentTurns = 0;
  /** Worker side: the routine look, and when the last view of any kind went out. */
  let watchTimer: ReturnType<typeof setInterval> | undefined;
  let lastLook = 0;
  /** Worker side: the last view sent, less its status line, and how many timer looks matched it. */
  let lastViewBody = "";
  let looksSkipped = 0;
  /** Supervisor side: cleared when the worker acknowledges the pair. */
  let pairTimer: ReturnType<typeof setTimeout> | undefined;
  /** Supervisor side: the writer tools this session had, so reset gives back exactly those. */
  let removedWriters: string[] = [];
  /** Supervisor side: who answered the roll call, collected only while /supervise is waiting. */
  let rollCall: Set<string> | undefined;
  /** A caller using PROGRAMMATIC_PAIR_EVENT waits for this explicit worker acknowledgement. */
  let pendingPair: { workerId: string; resolve(): void; reject(error: Error): void } | undefined;
  let resolveIntercomConnected!: () => void;
  const intercomConnected = new Promise<void>((resolve) => { resolveIntercomConnected = resolve; });

  /** PI_SUPERVISOR_DEBUG=1 traces the wire to stderr. The channel is invisible in transcripts. */
  const debug = (event: string, detail: unknown = {}) => {
    if (process.env.PI_SUPERVISOR_DEBUG) console.error(`[intercom-supervisor] ${event} ${JSON.stringify(detail)}`);
  };

  function save() {
    pi.appendEntry(STATE_ENTRY, state);
    showStatus();
  }

  function reanchorPlan() {
    if (!state.plan || state.role !== "supervisor") return;
    const policy = loadSupervisorPrompt(ctx.cwd).prompt;
    pi.sendMessage({ customType: "supervisor_plan", display: false, content: `${policy}

Supervise this plan; use review_goal only for an explicit goal request. The human's Ready approved the plan. Do not start a second worker.

Approved plan:
${state.goal}

Current plan (${state.plan.planPath}):
${planText(state.plan)}` }, { triggerTurn: false });
  }

  async function compactSupervisor(force = false) {
    if (!modelReady()) throw new Error("Supervisor model unavailable; select with /model before compaction");
    if (compacting) return compacting;
    if (!state.plan || !ctx.isIdle()) return;
    const tokens = ctx.getContextUsage?.()?.tokens;
    const measured = typeof tokens === "number" && Number.isFinite(tokens);
    if (force && measured && tokens <= 20_000) {
      ctx.ui.notify("Supervisor fork is already small; compaction skipped.", "info");
      reanchorPlan();
      return;
    }
    const threshold = Math.min(state.plan.compactTokens, Math.max(1, (ctx.model?.contextWindow ?? 200_000) - 20_000));
    if (!force && (!measured || tokens < threshold)) return;
    const generation = pairingGeneration;
    const bindingId = state.plan.id;
    compacting = new Promise<void>((resolve, reject) => ctx.compact({
      customInstructions: "Preserve the user's intent, decisions and their reasons, unresolved choices, plan path, and supervisor interventions. You are becoming/remaining the supervisor, not the worker.",
      onComplete: () => resolve(), onError: reject,
    }));
    try { await compacting; }
    finally { compacting = undefined; }
    if (!stopping && generation === pairingGeneration && state.plan?.id === bindingId && state.role === "supervisor") reanchorPlan();
  }

  function cancelGoalRequests(reason: string) {
    attached?.finish(undefined, new Error(reason)); attached = undefined;
    outgoingReview?.finish(undefined, new Error(reason)); outgoingReview = undefined;
    if (incomingReview && state.pairedId) send({ t: "goal_cancel", to: state.pairedId, requestId: incomingReview.requestId, bindingId: incomingReview.bindingId });
    incomingReview = undefined;
  }

  async function planRequest(request: PlanApiRequest): Promise<unknown> {
    if (duplicateIntercom) throw new Error("Duplicate standalone pi-intercom registration. Remove the old pi-intercom companion from Pi settings; pi-goals bundles it. Reload both sessions.");
    if (request.method !== "stop" && !modelReady()) throw new Error("Role model unavailable; configure the saved model or explicitly select with /model, then retry.");
    if (!ctx || stopping) throw new Error("Supervisor session is not ready");
    if (request.signal?.aborted) throw new Error("Supervisor request cancelled");
    if (["bootstrap", "status", "prepare"].includes(request.method) && !channel?.snapshot().connected) {
      const connected = pendingReply<void>(request.signal, () => {}, 30_000);
      void intercomConnected.then(() => connected.finish());
      await connected.promise;
    }
    if (stopping || request.signal?.aborted) throw new Error("Supervisor request cancelled");
    if (!channel?.snapshot().connected || !channel.snapshot().supported) throw new Error("Bundled Intercom is unavailable. Load the pi-goals package directory, not only src/index.ts, and reload both sessions");
    if (request.method === "status") {
      const live = await channel.listSessions();
      return { workerId: await resolveOwnId(), role: state.role, binding: state.plan, supervisorId: state.pairedId,
        connected: state.role === "worker" && !!state.plan && live.some(s => s.id === state.pairedId) };
    }
    if (request.method === "prepare") {
      if (!validBinding(request.binding) || request.binding.workerSession !== ctx.sessionManager.getSessionFile()) throw new Error("Invalid plan binding for this worker session");
      if (state.role !== "none" || state.plan) throw new Error("A supervisor is already associated; stop it before replacing the plan");
      state = { ...state, plan: request.binding }; save();
      return { workerId: await resolveOwnId() };
    }
    if (request.method === "bootstrap") {
      if (!validBinding(request.binding) || !request.workerId) throw new Error("Invalid supervisor bootstrap");
      const binding = { ...request.binding, ...(state.plan?.id === request.binding.id ? state.plan : {}), supervisorSession: ctx.sessionManager.getSessionFile() };
      if (!binding.supervisorSession || binding.supervisorSession === binding.workerSession) throw new Error("Supervisor must use a distinct persisted fork");
      if (state.plan?.id === binding.id && state.plan.stopped) throw new Error("This supervisor was stopped. Start a new pairing from the worker.");
      if (state.role === "supervisor" && state.plan?.id === binding.id && state.planInitialized && state.pairedId) {
        reanchorPlan(); await rejoinOrDrop(); return state.plan;
      }
      bootstrapPending = true;
      const generation = ++pairingGeneration;
      const cancelled = () => stopping || generation !== pairingGeneration || state.plan?.id !== binding.id || state.plan.stopped || request.signal?.aborted;
      state = { ...EMPTY_STATE, role: "supervisor", pairedId: request.workerId, plan: binding, goal: state.plan?.id === binding.id ? state.goal : planText(binding) };
      stripWriters(); showSupervisorTools(true); save();
      try {
        await compactSupervisor(true);
        if (cancelled()) throw new Error("Supervisor bootstrap cancelled");
        const worker = (await channel.listSessions()).find(s => s.id === request.workerId);
        if (cancelled()) throw new Error("Supervisor bootstrap cancelled");
        if (!worker) throw new Error("The specified worker is no longer connected");
        await startPair(worker, state.goal, ctx, binding);
        return binding;
      } catch (error) {
        if (!stopping && generation === pairingGeneration) reset("Supervisor initialization failed; retry from the worker");
        throw error;
      }
      finally { bootstrapPending = false; }
    }
    if (request.method === "stop") {
      if (!state.plan || request.bindingId !== state.plan.id) throw new Error("No matching plan pairing to stop");
      if (state.plan) send({ t: "plan_stop", to: "*", bindingId: state.plan.id });
      if (state.pairedId) send({ t: "unpair", to: state.pairedId });
      reset("Plan supervision stopped", true); return {};
    }
    if (!state.plan || request.bindingId !== state.plan.id) throw new Error("Plan pairing changed or is unavailable");
    if (request.method === "attached") {
      if (state.role === "worker" && (await channel.listSessions()).some(s => s.id === state.pairedId)) return state.plan;
      if (attached) throw new Error("Already waiting for the supervisor");
      const pending = pendingReply<unknown>(request.signal, () => { attached = undefined; });
      attached = pending;
      return pending.promise;
    }
    if (state.role !== "worker" || !state.pairedId) throw new Error("Supervisor is not paired; use /goals supervisor or turn the steward off");
    if (request.method === "activate") {
      state = { ...state, plan: { ...state.plan, active: true } }; save();
      send({ t: "plan_activate", to: state.pairedId, bindingId: state.plan!.id });
      startWatch();
      // The worker's work handoff is queued already. Never label this as an abandoned stopped worker.
      await publishView(ctx, "Ready selected; worker starting", sentTurns, false, true);
      return {};
    }
    if (request.method === "update") { send({ t: "plan_update", to: state.pairedId, bindingId: state.plan.id }); return {}; }
    if (request.method === "review") {
      if (outgoingReview) throw new Error("A goal review is already pending");
      if (!request.goal || request.planHash !== planHash(planText(state.plan))) throw new Error("The plan changed before goal review");
      const bindingId = state.plan.id;
      const peer = state.pairedId;
      const pending = pendingReply<GoalDecision>(request.signal, () => {
        outgoingReview = undefined;
        send({ t: "goal_cancel", to: peer, requestId: pending.requestId, bindingId });
      });
      const review = { requestId: pending.requestId, bindingId, goal: request.goal, planHash: request.planHash };
      outgoingReview = { ...pending, review };
      send({ t: "goal_review", to: peer, ...review });
      return pending.promise;
    }
    throw new Error("Unsupported plan operation");
  }
  pi.events.on(PLAN_API_EVENT, (request: PlanApiRequest) => {
    if (stopping || request?.version !== 1 || request.handled || typeof request.resolve !== "function" || typeof request.reject !== "function") return;
    request.handled = true;
    planRequest(request).then(request.resolve, (error: unknown) => request.reject!(error instanceof Error ? error : new Error(String(error))));
  });
  pi.on("session_shutdown", () => {
    stopping = true;
    pairingGeneration++;
    cancelGoalRequests("Session reloaded or ended; retry the goal review");
    clearInterval(watchTimer); clearTimeout(pairTimer);
  });

  /**
   * One footer line while a pairing is live, so both terminals say what they are.
   *
   * A pairing is otherwise invisible after the notice at the top scrolls away. wassname started a
   * supervisor, saw it sitting at the prompt, and could not tell that it had stopped supervising.
   * Mechanism borrowed from @diegopetrucci/pi-oracle, which puts its run in the same place.
   */
  function showStatus() {
    if (!ctx?.hasUI) return;
    if (state.role === "none") {
      ctx.ui.setStatus(STATUS_ID, undefined);
      return;
    }
    const text = state.role === "supervisor" ? `watching ${state.steerRounds}` : "watched";
    ctx.ui.setStatus(STATUS_ID, ctx.ui.theme.fg("accent", `${EYE} `) + ctx.ui.theme.fg("dim", text));
  }

  function send(message: Wire) {
    if (!channel) throw new Error("intercom-supervisor: intercom channel is not ready");
    channel.publish(message, { audience: "capable" });
  }

  /**
   * Put words in the supervisor's own context without starting a turn.
   *
   * The brief, the reanchor and a goal change all say "a view follows", and the view is the thing
   * to judge. A user message always starts a turn (pi types.d.ts:754), so the supervisor answered
   * these with a verdict before any view existed: twice on 2026-08-13, and 98 times an hour before
   * that. No wording stops it, because the turn should not be there at all. A custom message with
   * triggerTurn false joins the context and waits for the view to wake it (agent-session.d.ts:398).
   * display true keeps it on screen, where a user message used to be. - CLAUDE
   */
  function tellSupervisor(text: string) {
    pi.sendMessage({ customType: "supervisor_brief", content: text, display: true }, { triggerTurn: false });
  }

  function tellGoal() {
    if (!state.goal.includes("\n")) return;
    tellSupervisor(`<goal>\n${state.goal}\n</goal>`);
    reviewsSinceGoal = 0;
  }

  /**
   * Ask every session whether it can be supervised, and collect the ones that say yes.
   *
   * The broker roster is not the candidate list. It carries child runs from pi-subagents, sessions
   * that do not load this extension, sessions already paired, and registrations whose process has
   * gone. Observed 2026-08-13: five of them at once in one directory, and /supervise refused to
   * pick between them because every filter here worked by guessing from the outside.
   *
   * Each session knows its own answer, so it gives it. A child run reads SUBAGENT_ENV in its own
   * environment; a paired one knows it is paired; a dead one cannot answer at all. No process tree,
   * no naming convention.
   */
  async function askWhoIsFree(): Promise<Set<string>> {
    const found = new Set<string>();
    rollCall = found;
    send({ t: "who", to: "*" });
    await new Promise((resolve) => setTimeout(resolve, ROLL_CALL_MS));
    rollCall = undefined;
    debug("roll call", { answered: [...found].map((id) => id.slice(0, 8)) });
    return found;
  }

  /**
   * Our own record in the broker registry. The broker records pid at registration, so we match on
   * it. Read fresh every time: presence keeps model and context use up to date in here.
   */
  async function ownSession(): Promise<any> {
    const sessions = await channel!.listSessions();
    const mine = sessions.find((s: any) => s.pid === process.pid);
    if (!mine) throw new Error("intercom-supervisor: this session is not registered with the intercom broker");
    ownId = mine.id;
    return mine;
  }

  /** Our own intercom session ID, which never changes, so the first answer is kept. */
  async function resolveOwnId(): Promise<string> {
    return ownId || (await ownSession()).id;
  }

  /**
   * Show or hide the supervisor tools. setActiveTools ignores names it does not know, so the list
   * is read back: a hide that leaves them visible is the confusion this exists to stop.
   */
  function showSupervisorTools(on: boolean) {
    const rest = pi.getActiveTools().filter((t: string) => !SUPERVISOR_TOOLS.includes(t));
    const enabled = SUPERVISOR_TOOLS.filter(name => name !== "review_goal" || state.plan);
    pi.setActiveTools(on ? [...rest, ...enabled] : rest);
    const now = pi.getActiveTools().filter((t: string) => SUPERVISOR_TOOLS.includes(t));
    if (on ? now.length !== enabled.length : now.length > 0) {
      throw new Error(
        `intercom-supervisor: setActiveTools did not ${on ? "add" : "remove"} the supervisor tools, left ${now.join(", ") || "none"}`,
      );
    }
  }

  /**
   * Take the writing tools off this session. Supervising is a read-only job in a directory
   * another agent is writing to. reset() hands them back.
   *
   * These live on the pi API, not on the command context. Reaching for the context is what let a
   * supervisor make 36 bash calls in the session that ran /supervise: the old code wrote
   * context.getActiveTools?.() ?? [], got undefined, kept an empty list, and skipped in silence.
   * Unguarded now, and the list is read back, so a strip that does nothing throws instead.
   */
  function stripWriters(): string[] {
    const before: string[] = pi.getActiveTools();
    const kept = before.filter((t: string) => !WRITER_TOOLS.has(t.toLowerCase()));
    // Remember the names removed, not the whole list. Other extensions add and remove their own
    // tools while supervision runs (pi-context-prune adds context_prune, pi-telegram suspends its
    // own), so restoring a snapshot taken hours ago would silently undo their decisions.
    removedWriters = [...new Set([...removedWriters, ...before.filter((t: string) => WRITER_TOOLS.has(t.toLowerCase()))])];
    pi.setActiveTools(kept);
    const still = pi.getActiveTools().filter((t: string) => WRITER_TOOLS.has(t.toLowerCase()));
    if (still.length) throw new Error(`intercom-supervisor: setActiveTools did not remove ${still.join(", ")}`);
    return kept;
  }

  /**
   * What a restored pairing means on the wire, checked once the channel exists.
   *
   * restoreState reads the transcript, which is right for the goal and the round count and wrong
   * for pairedId: that addresses a live process, and after a resume or a /reload the process on
   * the other end may be gone. A resumed session then sits idle claiming a pairing, says nothing
   * on screen, and refuses /supervise until you work out it needs /supervise stop.
   *
   * The broker's registry is the truth about who exists now, so ask it. Either way this prints,
   * because "supervising, waiting" and "the other session is gone" look identical otherwise.
   */
  async function rejoinOrDrop() {
    if (!modelReady() || duplicateIntercom || bootstrapPending || !state.role || !state.pairedId || (state.plan && state.role === "supervisor" && !state.planInitialized)) return;
    const live = await channel!.listSessions();
    if (state.plan) {
      // Pi session files identify the pair across process restarts; broker IDs identify live peers.
      send({ t: "plan_hello", to: "*", bindingId: state.plan.id, role: state.role as "worker" | "supervisor", sessionFile: ctx.sessionManager.getSessionFile() });
      if (!live.some((s: any) => s.id === state.pairedId)) {
        if (state.role === "supervisor") stripWriters();
        ctx.ui.notify("Plan supervisor peer is disconnected; retaining this session and waiting for reconnect.", "warning");
        return;
      }
    }
    if (!live.some((s: any) => s.id === state.pairedId)) {
      reset(`intercom-supervisor: ${state.pairedId.slice(0, 8)} is gone, so the pairing is dropped. Run /supervise to start again.`);
      return;
    }
    if (state.role !== "supervisor") {
      // A worker reloaded at the prompt takes no turn, so this is its only chance to start watching.
      startWatch();
      ctx?.ui?.notify?.(`intercom-supervisor: still supervised by ${state.pairedId.slice(0, 8)}`, "info");
      return;
    }
    // The strip lives in the /supervise handler and savedTools is memory, so a resumed supervisor
    // has bash and the edit tools back in a directory the worker is writing to.
    stripWriters();
    reanchorPlan();
    // Say the goal and the answer shape again. A /reload is how a changed prompt reaches a running
    // session, and the brief goes out only at pairing, so without this a wording fix needs a fresh
    // pairing and loses the supervisor's memory of its own steers.
    tellSupervisor(REANCHOR(state.goal, state.steerRounds));
    reviewsSinceGoal = 0;
    // Ask for a view rather than wait for one. A supervisor that came back from a crash, a credit
    // failure or a /reload holds a stale picture, and answering from a stale picture is how it
    // invents a fact. Only the worker makes views, so it has to ask, and nobody should have to
    // know that: restarting the session is the whole recovery.
    send({ t: "look", to: state.pairedId });
    ctx?.ui?.notify?.(`intercom-supervisor: still supervising ${state.pairedId.slice(0, 8)}, asked it for a view`, "info");
  }

  function finishPair(error?: Error) {
    const pending = pendingPair;
    pendingPair = undefined;
    if (!pending) return;
    if (error) pending.reject(error);
    else pending.resolve();
  }

  /** Everything that ends a pairing goes through here, so no stale view or timer survives it. */
  function reset(note: string, rememberStop = false) {
    pairingGeneration++;
    const stoppedPlan = state.plan && (state.plan.stopped || (rememberStop && state.role === "supervisor")) ? { ...state.plan, stopped: true, active: false } : undefined;
    cancelGoalRequests(note);
    clearTimeout(pairTimer);
    pairTimer = undefined;
    finishPair(new Error(note));
    clearInterval(watchTimer);
    watchTimer = undefined;
    if (removedWriters.length) {
      pi.setActiveTools([...pi.getActiveTools(), ...removedWriters]); // give back what we took
      removedWriters = [];
    }
    showSupervisorTools(false);
    state = { ...EMPTY_STATE, ...(stoppedPlan ? { plan: stoppedPlan } : {}) };
    latestView = "";
    reviewsSinceGoal = 0;
    lastProgress = "";
    staleReviews = 0;
    sentTurns = 0;
    save();
    ctx?.ui?.notify?.(note, "info");
  }

  // ---- inbound, one branch per role ------------------------------------------------------

  async function onWire(from: string, wire: Wire) {
    const me = await resolveOwnId();
    debug("wire in", { t: wire.t, from: from.slice(0, 8), forUs: wire.to === me, role: state.role });

    // Answered before the addressed-to-us check below, because a roll call goes to everyone.
    if (wire.t === "who") {
      if (from !== me && state.role === "none" && !process.env[SUBAGENT_ENV]) send({ t: "here", to: from });
      return;
    }
    if (wire.t === "plan_stop" && state.role === "supervisor" && state.plan?.id === wire.bindingId && from === state.pairedId) {
      ctx.abort(); reset("Plan supervision stopped", true); return;
    }
    if ((wire.t === "plan_hello" || wire.t === "plan_hello_ack") && state.plan && !state.plan.stopped && !bootstrapPending && (state.role === "worker" || (state.role === "supervisor" && state.planInitialized))) {
      const expected = state.role === "worker" ? state.plan.supervisorSession : state.plan.workerSession;
      if (wire.bindingId !== state.plan.id || wire.role === state.role || wire.sessionFile !== expected || (wire.to !== "*" && wire.to !== me)) return;
      state = { ...state, pairedId: from }; save();
      if (wire.t === "plan_hello") send({ t: "plan_hello_ack", to: from, bindingId: wire.bindingId, role: state.role as "worker" | "supervisor", sessionFile: ctx.sessionManager.getSessionFile() });
      if (state.role === "worker") { attached?.finish(state.plan); attached = undefined; startWatch(); }
      return;
    }
    if (wire.to !== me) return;

    // Collected only while /supervise is waiting, so a late answer lands nowhere and is dropped.
    if (wire.t === "here") {
      rollCall?.add(from);
      return;
    }

    if (wire.t === "pair") {
      // A plan-owned worker accepts only its prepared pairing, not any peer in the directory.
      if ((wire.plan || state.plan) && (!wire.plan || wire.plan.id !== state.plan?.id || wire.plan.workerSession !== ctx.sessionManager.getSessionFile())) return;
      // Last pair wins. First-wins left a worker bound forever to a supervisor that had died, and
      // told nobody. The loser is told, so neither side waits on a pairing it does not have.
      if (state.pairedId && state.pairedId !== from) send({ t: "unpair", to: state.pairedId });
      // We are a worker now, so any pair we sent as a supervisor is void. Leaving that timer armed
      // would kill this healthy pairing ten seconds later, blaming a session no longer involved.
      clearTimeout(pairTimer);
      pairTimer = undefined;
      // A same-binding replay must not undo Ready already completed by this worker.
      const plan = wire.plan ? { ...wire.plan, active: state.plan?.active ?? wire.plan?.active } : undefined;
      state = { ...EMPTY_STATE, role: "worker", pairedId: from, goal: plan ? planText(plan) : wire.goal, ...(plan ? { plan } : {}) };
      latestView = "";
      lastProgress = "";
      staleReviews = 0;
      save();
      send({ t: "paired", to: from, ...(state.plan ? { plan: state.plan } : {}) });
      if (state.plan) { attached?.finish(state.plan); attached = undefined; return; }
      pi.events.emit(WORKER_PAIRED_EVENT, { supervisorIntercomId: from });
      ctx?.ui?.notify?.(`supervised by ${from.slice(0, 8)}: ${firstLine(wire.goal)}`, "info");
      // A first view goes with the acknowledgement. Without it the supervisor's opening turn has
      // nothing to read, and it answers anyway: on 2026-08-13 it called let_it_run 98 times over
      // "waiting for the first view". A worker paired while idle never settles, so waiting for
      // agent_settled can mean waiting for ever.
      await publishView(ctx, "sent at pairing");
      startWatch(); // paired while sitting at the prompt is the common case, and turn_start may never come
      return;
    }

    if (from !== state.pairedId) return; // ignore anything from a session we are not paired with

    if ("bindingId" in wire && wire.bindingId !== state.plan?.id) return;
    if (wire.t === "plan_activate") { state = { ...state, plan: { ...state.plan!, active: true } }; save(); return; }
    if (wire.t === "plan_update") { reanchorPlan(); return; }
    if (wire.t === "goal_cancel") {
      if (outgoingReview?.requestId === wire.requestId) outgoingReview.finish(undefined, new Error("Supervisor cancelled the review; retry"));
      if (incomingReview?.requestId === wire.requestId) { incomingReview = undefined; ctx.abort(); }
      return;
    }
    if (wire.t === "goal_decision") {
      const pending = outgoingReview;
      if (!pending || pending.review.requestId !== wire.requestId || pending.review.goal !== wire.goal || pending.review.planHash !== wire.planHash) return;
      outgoingReview = undefined;
      pending.finish(wire, planHash(planText(state.plan!)) !== wire.planHash ? new Error("Plan changed during supervisor review") : undefined);
      return;
    }
    if (wire.t === "goal_review" && state.role === "supervisor") {
      if (incomingReview || planHash(planText(state.plan!)) !== wire.planHash) {
        send({ ...wire, t: "goal_decision", to: from, decision: "needs_work", reason: "Another review is pending or the plan changed; retry." }); return;
      }
      incomingReview = wire;
      await compactSupervisor();
      if (incomingReview !== wire || stopping) return;
      reanchorPlan();
      pi.sendUserMessage(`Goal sign-off request ${wire.requestId}. Goal: ${wire.goal}
Judge direction and scope against the approved plan and current evidence. A fresh judge will check artifacts independently. Call review_goal with this requestId and approve, needs_work, or needs_user. Do not call done: this is one goal, not the end of supervision.`, ctx.isIdle() ? undefined : { deliverAs: "followUp" });
      return;
    }
    if (wire.t === "paired" && state.role === "supervisor") {
      if (state.plan) {
        if (wire.plan?.id !== state.plan.id || pendingPair?.workerId !== from) return;
        state = { ...state, plan: { ...state.plan, active: wire.plan.active }, planInitialized: true }; save();
      }
      clearTimeout(pairTimer);
      pairTimer = undefined;
      finishPair();
      return;
    }

    if (wire.t === "goal" && state.role === "worker") {
      // The supervisor inferred a goal. The worker holds the copy the view header is built from,
      // so without this the header says "not set" for the rest of the run.
      state = { ...state, goal: wire.goal };
      save();
      ctx?.ui?.notify?.(`goal set by the supervisor: ${wire.goal}`, "info");
      return;
    }

    if (wire.t === "look" && state.role === "worker") {
      // Only the worker can make a view, so a supervisor that lost its place has to ask. It loses
      // its place whenever its own turn ends without one: a crash, a credit failure, a /reload.
      // Its answer to a stale context is to invent, so give it real data instead.
      // From turn 0, not the diff. A supervisor only asks after a crash or a /reload, when its own
      // copy is gone, and answering that with "0 new turns since your last look" leaves it inventing.
      if (!state.plan || state.plan.active) await publishView(ctx, "sent because you asked for a view", 0);
      return;
    }

    if (wire.t === "directive" && state.role === "worker") {
      if (!modelReady() || (state.plan && !state.plan.active)) return;
      // Busy worker gets "steer": delivered after the current tool calls, before the next LLM call.
      // "followUp" would make it finish the whole task first, so a correction arrives too late to
      // correct anything. Idle worker takes no option, so the message starts a turn.
      pi.sendUserMessage(`[supervisor] ${wire.text}`, ctx?.isIdle() ? undefined : { deliverAs: "steer" });
      return;
    }

    if (wire.t === "view" && state.role === "supervisor") {
      const generation = pairingGeneration;
      const bindingId = state.plan?.id;
      if (state.plan) {
        if (!state.plan.active || !state.planInitialized) return;
        await compactSupervisor();
      }
      if (stopping || generation !== pairingGeneration || state.role !== "supervisor" || from !== state.pairedId || state.plan?.id !== bindingId || (state.plan && !state.plan.active)) return;
      if (state.plan) reanchorPlan();
      latestView = wire.view;
      workerStopped = wire.stopped;
      if (reviewsSinceGoal >= GOAL_REVIEW_INTERVAL - 1) tellGoal();
      else reviewsSinceGoal += 1;
      // A new view is a new look, so it gets its own verdict. agent_start alone is not enough: a
      // followUp is consumed inside the running agent loop, so no second agent_start fires and the
      // count carries over. That aborted the second honest verdict of a busy night. - CLAUDE
      verdictsThisLook = 0;
      // followUp, not steer: let the supervisor finish the decision it is making, then look again.
      // With no option at all pi throws "Agent is already processing" and the view is lost, which
      // on a half hour look means the supervisor skips a whole look for no visible reason.
      pi.sendUserMessage(
        REVIEW_NUDGE(wire.view, state.steerRounds, wire.stopped),
        ctx?.isIdle() ? undefined : { deliverAs: "followUp" },
      );
      return;
    }

    if (wire.t === "done" || wire.t === "unpair") {
      if (state.plan && state.role === "supervisor") ctx.abort();
      reset(`supervision ended: ${wire.t === "done" ? wire.reason : "unpaired"}`, true);
    }
  }

  // ---- lifecycle -------------------------------------------------------------------------

  // The other reset. This one covers a turn the human starts by typing; the view branch above
  // covers a view, which is the usual way a look begins.
  pi.on("agent_start", () => {
    verdictsThisLook = 0;
  });

  /**
   * A finished look keeps its verdict and loses the raw material behind it.
   *
   * Every look brings a view of about 1.4k tokens and a block of thinking about as long, and neither
   * means anything once the verdict is written. Session 019ffa73, 16 hours and 75 looks: the context
   * ran 37.9k -> 234.7k with no compaction, and was 56% view bodies and 32% old thinking by
   * character count. What the supervisor actually needs is the 7% that is its own verdicts, e.g.
   * "job 26 Evidence-b partially landed: post rho 0.726 > prompted 0.718 (was tied before rebuild),
   * probe d flipped +0.059". Those are its running notes on the worker, and better memory than the
   * turns it read to write them.
   *
   * Cache reads are $0.004/Mtok, so this was never about the bill. It is that a model judging one
   * view should not be reading 234k tokens to do it.
   *
   * Views are incremental, each covering what is new since the last, so the newest few stay whole
   * in case the current one reads against them. scripts/measure-prune.ts replays a real session.
   */
  const LOOKS_KEPT = 3;
  pi.on("context", (event: any) => {
    if (state.role !== "supervisor") return;
    const lastPlan = event.messages.findLastIndex((m: any) => m.customType === "supervisor_plan");
    const messages = event.messages.filter((m: any, i: number) => m.customType !== "supervisor_plan" || i === lastPlan);
    const isView = (m: any) =>
      m.role === "user" && m.content?.some?.((c: any) => c.type === "text" && isViewText(c.text));

    // Everything before the oldest look we keep whole is history.
    const views = messages.flatMap((m: any, i: number) => (isView(m) ? [i] : []));
    if (views.length <= LOOKS_KEPT) return { messages };
    const cut = views[views.length - LOOKS_KEPT];

    // New objects, never a mutation: event.messages is the live branch the session also reads from.
    return {
      messages: messages.flatMap((m: any, i: number) => {
        if (i >= cut) return [m];
        if (isView(m)) return [{ ...m, content: [{ type: "text", text: VIEW_PRUNED }] }];
        if (m.role !== "assistant") return [m];
        const kept = (m.content ?? []).filter((c: any) => c.type !== "thinking");
        // A message that was only thinking has nothing left to say, and holds no tool call to orphan.
        return kept.length ? [{ ...m, content: kept }] : [];
      }),
    };
  });

  pi.on("session_compact", async (event: { willRetry?: boolean }, context: any) => {
    ctx = context;
    // Pi retries overflow recovery immediately after this event. Queue the rubric for its next
    // ordinary turn, so the failed assistant remains final and can be removed.
    if (state.role === "supervisor") {
      if (state.plan && !event.willRetry) reanchorPlan();
      if (event.willRetry) reviewsSinceGoal = GOAL_REVIEW_INTERVAL - 1;
      else tellGoal();
    }
  });

  const intercomRegistration = {
    namespace: NAMESPACE,
    ownerEligible: false,
    onReady: (value: IntercomExtensionChannel) => {
      if (channel && channel !== value) {
        duplicateIntercom = true;
        ctx?.ui?.notify?.("Duplicate standalone pi-intercom registration. Remove the old companion package; pi-goals bundles Intercom. Reload both sessions.", "error");
        return;
      }
      channel = value;
      if (!value.snapshot().connected) return;
      resolveIntercomConnected();
      if (ctx) rejoinOrDrop().catch((err: Error) => debug("rejoin failed", { error: err.message }));
    },
    onEvent: (event: IntercomExtensionEvent) => {
      if (event.type === "connection" && event.connected) {
        resolveIntercomConnected();
        if (ctx) rejoinOrDrop().catch((err: Error) => debug("rejoin failed", { error: err.message }));
        return;
      }
      if (event.type === "message" && isWire(event.payload)) {
        // Not awaited by the caller, so a rejection here would be an unhandled rejection with no
        // notice. resolveOwnId throws during a startup race.
        onWire(event.fromSessionId, event.payload).catch((err: Error) => {
          debug("wire dropped", { error: err.message });
          ctx?.ui?.notify?.(`intercom-supervisor: dropped a message, ${err.message}`, "error");
        });
      }
    },
  };

  function registerIntercom() {
    if (intercomRegistered || channel) return;
    intercomRegistered = pi.events.emit(INTERCOM_EXTENSION_REGISTER_EVENT, intercomRegistration);
  }

  pi.events.on(INTERCOM_EXTENSION_REGISTRY_READY_EVENT, () => {
    // A registry announces itself once. If we already registered, another standalone copy loaded.
    if (intercomRegistered || channel) {
      duplicateIntercom = true;
      ctx?.ui?.notify?.("Duplicate standalone pi-intercom registration. Remove the old companion package; pi-goals bundles Intercom. Reload both sessions.", "error");
      return;
    }
    registerIntercom();
  });
  registerIntercom();

  function initializeSession(context: any) {
    ctx = context;
    if (duplicateIntercom) ctx.ui.notify("Duplicate standalone pi-intercom registration. Remove the old companion package; pi-goals bundles Intercom. Reload both sessions.", "error");
    if (sessionInitialized) return;
    sessionInitialized = true;
    state = restoreState(context.sessionManager.getEntries());
    // A fresh fork may not yet have supervise-state, especially if model restoration paused it.
    if (context.sessionManager.getBranch().some((entry: any) => entry.type === "custom" && entry.customType === "pi-goals-supervisor")) stripWriters();
    // Before anything else, because a worker that can see steer and worker_view starts guessing
    // that it is a supervisor. rejoinOrDrop below may still drop the pairing and hide them again.
    showSupervisorTools(state.role === "supervisor");
    showStatus(); // a resumed pairing has no notice to read, so the footer is all you get
    if (channel?.snapshot().connected) {
      resolveIntercomConnected();
      rejoinOrDrop().catch((err: Error) => debug("rejoin failed", { error: err.message }));
    }
  }

  pi.on("session_start", async (_event: unknown, context: any) => {
    initializeSession(context);
    registerIntercom();
  });
  pi.on("before_agent_start", async (_event: unknown, context: any) => {
    initializeSession(context);
    registerIntercom();
  });

  /**
   * Publish what the worker looks like right now. Used at pairing, on a timer and when asked.
   * `since` is the turn the view starts at: the diff for a routine look, 0 when the supervisor
   * needs the whole picture again.
   */
  async function publishView(context: any, why: string, since = sentTurns, onlyIfChanged = false, starting = false) {
    if (!modelReady() || publishing || outgoingReview || (state.plan && !state.plan.active)) return;
    publishing = true;
    const bindingId = state.plan?.id;
    const peer = state.pairedId;
    try {
    // Claimed before the await, not after. ps takes long enough that a second timer tick would
    // otherwise start its own look while this one is still waiting.
    lastLook = Date.now();
    const entries = context.sessionManager.getBranch() as any;
    // Checked here too. This view replaces the one done reads, so leaving it out would report
    // "child pi processes still running: none" and unblock done while a subagent is running.
    const background = state.plan ? await backgroundState(pi) : undefined;
    const subagents = state.plan ? [] : await childPiProcesses();
    if (state.pairedId !== peer || state.plan?.id !== bindingId || stopping) return;
    // Asked at pairing and on a rejoin, and the worker is often sitting at the prompt then. Saying
    // "working" there sends the supervisor a check-in nudge about a worker that is waiting on it.
    const idle = !starting && context.isIdle() && (!background || background.quiet);
    // One clock for both ways of being stuck: at the prompt, and inside a command that never
    // returns. It goes in the status line because bodyOf strips that line, so a number that moves
    // on its own cannot defeat the unchanged-view skip below.
    let view = buildView({
      goal: state.goal,
      status: `${idle ? "stopped" : "working"}, ${why}, no new turn for ${age(sinceLastTurn(entries))}`,
      entries,
      since,
      subagents,
      model: workerModel(await ownSession()),
    });
    if (background) view += `\ntracked background work: ${background.description}\n`;
    // A timer look at a worker that has done nothing since the last one wakes the supervisor to read
    // a view it has already read. Session 019ffa73: 13 of 92 verdicts were "check-in with no new
    // turns ... nothing to judge". The supervisor loses nothing by not being asked, because the view
    // is the same view. It is asked anyway after LOOKS_SKIPPED_MAX, since a worker that has not moved
    // for hours is itself worth seeing, and the elapsed seconds in the status line say so.
    if (onlyIfChanged) {
      if (bodyOf(view) === lastViewBody && looksSkipped < LOOKS_SKIPPED_MAX) {
        looksSkipped += 1;
        debug("look skipped, nothing new since the last view", { looksSkipped });
        return;
      }
      looksSkipped = 0;
    }
    lastViewBody = bodyOf(view);

    modelTurns = 0;
    settledCheck = false;
    sentTurns = turnsSince(entries);
    send({ t: "view", to: state.pairedId, view, stopped: idle });
    debug("published view", { why, to: state.pairedId, sentTurns, idle });
    } finally { publishing = false; }
  }

  /**
   * The timer look. A human supervising does not read every token; they wander past every few
   * minutes and interrupt if the work has gone somewhere wrong. This is that, so the supervisor
   * keeps roughly the perspective you would have with the two windows side by side.
   *
   * It runs whether or not the worker is working, and from the moment the worker is paired rather
   * than from its next turn. Both of those are the same bug twice, an idle worker nobody is looking
   * at. It used to stop on agent_settled, since a stopped worker cannot change, and on 2026-08-14
   * that left a stopped worker and a supervisor that had answered let_it_run sitting silent for two
   * and a half hours. It used to start only on turn_start, so a worker that paired or reloaded while
   * sitting at the prompt had no timer at all, which is the same silence reached from the other end.
   */
  function startWatch() {
    if (!modelReady() || state.role !== "worker" || !channel || watchTimer || (state.plan && !state.plan.active)) return;
    watchTimer = setInterval(() => {
      if (!modelReady()) return;
      if (state.plan && settledCheck && ctx.isIdle()) {
        void backgroundState(pi).then(background => { if (background.quiet) return publishView(ctx, "tracked background work finished"); }).catch(() => {});
      }
      if (Date.now() - lastLook < (state.plan?.intervalMs ?? WATCH_INTERVAL_MS)) return;
      // A stopped worker is always reported, never skipped as unchanged: an unchanged stopped worker
      // is the state that needs a steer, and nothing else is going to bring it up.
      const idle = ctx.isIdle();
      publishView(ctx, idle ? "looked at again" : "routine check in", sentTurns, !state.plan && !idle).catch((err: Error) => {
        debug("timer look failed", { error: err.message });
      });
    }, WATCH_POLL_MS);
    // Watching is not a reason for a process to stay alive. It ran from turn_start before, which no
    // test reaches, so an interval from pairing time held node's test runner open for ever.
    watchTimer.unref();
  }

  pi.on("turn_start", async (_event: unknown, context: any) => {
    ctx = context;
    // Set again, and before the role check, because a status set during session_start does not
    // survive: the footer had not mounted yet, and nothing redraws it until the next save().
    showStatus();
    startWatch();
  });

  pi.on("turn_end", async (_event: unknown, context: any) => {
    ctx = context;
    if (state.role !== "worker" || !state.plan?.active) return;
    modelTurns += 1;
    if (modelTurns >= state.plan.everyTurns) await publishView(ctx, "model-turn check in");
  });
  for (const event of ["processes:ended", "subagent:async-complete"]) pi.events.on(event, () => {
    if (state.plan?.active && state.role === "worker" && ctx?.isIdle()) {
      settledCheck = true;
      void backgroundState(pi).then(background => { if (background.quiet) return publishView(ctx, "tracked background work finished"); }).catch(() => {});
    }
  });

  /** Fires only when no retry, compaction, or queued continuation will run, so the worker is truly done. */
  pi.on("agent_settled", async (_event: unknown, context: any) => {
    ctx = context;
    showStatus();
    debug("agent_settled", { role: state.role, hasChannel: Boolean(channel) });
    if (state.role !== "worker" || !channel) return;
    if (state.plan) {
      if (!state.plan.active || outgoingReview) return;
      settledCheck = true;
      if ((await backgroundState(pi)).quiet && Date.now() - lastLook > 1_000) await publishView(context, "worker settled");
      return;
    }
    // The timer keeps running. See the turn_start comment: stopping it here is what let the pairing
    // go silent for two and a half hours after the supervisor answered let_it_run to a stopped worker.
    try {
      // A subagent runs as its own process and leaves no unanswered tool call, so a settled worker
      // can still be spending. Report it and let the supervisor steer; do not wait here.
      const subagents = await childPiProcesses();
      const entries = context.sessionManager.getBranch() as any;
      const progress = progressKey(entries);
      staleReviews = progress === lastProgress ? staleReviews + 1 : 0;
      lastProgress = progress;
      const view = buildView({
        goal: state.goal,
        status: "stopped, just now, no new turn for 0s",
        entries,
        since: sentTurns,
        stale: staleReviews,
        subagents,
        model: workerModel(await ownSession()),
      });
      sentTurns = turnsSince(entries);
      send({ t: "view", to: state.pairedId, view, stopped: true });
      lastLook = Date.now();
      debug("published view", { bytes: Buffer.byteLength(view), to: state.pairedId, stale: staleReviews, subagents });
    } catch (err) {
      // Nothing awaits this handler, so rethrowing would be an unhandled rejection nobody sees,
      // and the supervisor would silently never wake again.
      debug("view publish failed", { error: (err as Error).message });
      context.ui?.notify?.(`intercom-supervisor: could not send the view, ${(err as Error).message}`, "error");
    }
  });

  // ---- supervisor side: one command and three tools ---------------------------------------

  function startPair(worker: any, goal: string, context: any, plan?: PlanBinding): Promise<void> {
    if (!channel) throw new Error("intercom-supervisor: intercom is not connected");
    if (state.role !== "none" && !(plan && bootstrapPending && state.pairedId === worker.id && state.plan?.id === plan.id)) throw new Error(`intercom-supervisor: already paired with ${state.pairedId.slice(0, 8)} as ${state.role}`);
    const target = worker.name ?? worker.id.slice(0, 8);
    state = { ...EMPTY_STATE, role: "supervisor", pairedId: worker.id, goal, ...(plan ? { plan } : {}) };
    latestView = "";
    reviewsSinceGoal = 0;
    save();
    const kept = stripWriters();
    showSupervisorTools(true);

    const { prompt, source } = loadSupervisorPrompt(context.cwd);
    tellSupervisor(BRIEF(prompt, goal, target));
    send({ t: "pair", to: state.pairedId, goal: plan ? "Plan-aware supervision" : goal, ...(plan ? { plan } : {}) });
    const acknowledgement = new Promise<void>((resolve, reject) => {
      pendingPair = { workerId: worker.id, resolve, reject };
    });
    pairTimer = setTimeout(() => {
      send({ t: "unpair", to: state.pairedId });
      reset(`intercom-supervisor: ${target} never acknowledged. It probably does not load this extension.`);
    }, PAIR_ACK_TIMEOUT_MS);
    context.ui?.notify?.(`supervising ${target} (policy: ${source}, tools: ${kept.join(", ")})`, "info");
    return acknowledgement;
  }

  async function pairPublishedWorker(workerIntercomId: string, goal: string, context: any): Promise<void> {
    await intercomConnected;
    const me = await resolveOwnId();
    if (workerIntercomId === me) throw new Error("intercom-supervisor: cannot supervise this session");
    const worker = (await channel!.listSessions()).find((session: any) => session.id === workerIntercomId);
    if (!worker) throw new Error(`intercom-supervisor: worker ${workerIntercomId.slice(0, 8)} is not connected`);
    await startPair(worker, readGoal(context.cwd, goal), context);
  }

  pi.events.on(WORKER_STATE_EVENT, (reply: (state: { intercomId: string; paired: boolean }) => void) => {
    if (typeof reply !== "function") return;
    resolveOwnId().then((intercomId) => reply({ intercomId, paired: state.role === "worker" }));
  });
  pi.events.emit(API_READY_EVENT, { version: 1 });

  pi.events.on(PROGRAMMATIC_PAIR_EVENT, (raw: unknown) => {
    const request = raw as Partial<ProgrammaticPairRequest>;
    if (request.version !== 1 || typeof request.workerIntercomId !== "string" || !request.workerIntercomId || typeof request.goal !== "string" || !request.goal.trim() || typeof request.resolve !== "function" || typeof request.reject !== "function") return;
    pairPublishedWorker(request.workerIntercomId, request.goal, ctx)
      .then(request.resolve, (error: unknown) => request.reject!(error instanceof Error ? error : new Error(String(error))));
  });

  pi.registerCommand("supervise", {
    description: "Supervise the other pi session here: /supervise [goal or path to a goal file], /supervise @name [goal], /supervise goal <new goal>, /supervise look, /supervise stop",
    handler: async (args: string, context: any) => {
      ctx = context;
      const text = args.trim();
      if (!channel) {
        context.ui?.notify?.("intercom-supervisor: intercom is not connected", "error");
        return;
      }
      if (text === "stop") {
        if (state.pairedId) send({ t: "unpair", to: state.pairedId });
        reset("supervision stopped", true);
        return;
      }
      if (text === "look") {
        if (state.role !== "supervisor") {
          context.ui?.notify?.("intercom-supervisor: not supervising, so there is nothing to look at", "error");
          return;
        }
        send({ t: "look", to: state.pairedId });
        context.ui?.notify?.(`asked ${state.pairedId.slice(0, 8)} for a view`, "info");
        return;
      }
      // Change the goal without breaking the pairing. Stopping and pairing again is the only other
      // way, and that throws away the supervisor's memory of its own steers.
      if (text === "goal" || text.startsWith("goal ")) {
        if (state.plan) { context.ui.notify("This goal comes from the worker's plan. Edit that plan rather than replacing the supervisor's copy.", "warning"); return; }
        const goal = readGoal(context.cwd, text.slice(4).trim());
        if (state.role !== "supervisor") {
          context.ui?.notify?.("intercom-supervisor: not supervising, so there is no goal to change", "error");
          return;
        }
        if (!goal) {
          context.ui?.notify?.(`intercom-supervisor: the goal now is: ${state.goal || "not set"}`, "info");
          return;
        }
        state = { ...state, goal };
        save();
        send({ t: "goal", to: state.pairedId, goal }); // the worker heads every view with it
        // Tell the supervisor now, and ask for a view, so it judges the new goal at once instead of
        // waiting up to half an hour for the next look.
        tellSupervisor(GOAL_CHANGED(goal));
        reviewsSinceGoal = 0;
        send({ t: "look", to: state.pairedId });
        context.ui?.notify?.(`goal changed: ${goal}`, "info");
        return;
      }
      if (state.role !== "none") {
        context.ui?.notify?.(
          `intercom-supervisor: already paired with ${state.pairedId.slice(0, 8)} as ${state.role}. Run /supervise stop first.`,
          "error",
        );
        return;
      }

      const me = await resolveOwnId();
      const listed = (await channel.listSessions()).filter((s: any) => s.id !== me);
      // The id prefix is the start of the "pi --session <id>" line pi prints in every terminal at
      // startup, so it is something you can match against a window.
      const describe = (rows: any[]) =>
        rows.map((s: any) => `${s.name ?? "(unnamed)"} ${s.id.slice(0, 8)} in ${s.cwd}`).join(", ") || "none";
      const first = text.split(/\s+/, 1)[0];

      // A target is written @name, so nothing has to be guessed from a goal that has spaces in it.
      // Before this, a first word that matched no session was silently swallowed into the goal:
      // "/supervise LUCID do the thing" set the goal to "LUCID do the thing" and said nothing.
      let worker: any;
      let goal: string;
      if (first.startsWith("@")) {
        // Matched against every session, and no roll call: you named it, so it is the target, and
        // the pair acknowledgement below is the test of whether it can take the job.
        const want = first.slice(1);
        const match = listed.filter((s: any) => s.name === want || s.id === want || s.id.startsWith(want));
        if (match.length !== 1) {
          context.ui?.notify?.(
            `intercom-supervisor: ${match.length} sessions match @${want}. Seen: ${describe(listed)}`,
            "error",
          );
          return;
        }
        worker = match[0];
        goal = readGoal(context.cwd, text.slice(first.length).trim());
      } else {
        // Nothing named, so the whole line is the goal and this has to find the worker.
        goal = readGoal(context.cwd, text);
        const here = listed.filter((s: any) => s.cwd === context.cwd);
        if (!here.length) {
          context.ui?.notify?.(`intercom-supervisor: no other session in ${context.cwd}`, "error");
          return;
        }
        // The roll call answers who can actually take the job. One free session is the ordinary
        // case, and it pairs with no question asked.
        const free = await askWhoIsFree();
        const open = here.filter((s: any) => free.has(s.id));
        if (open.length === 1) {
          worker = open[0];
        } else {
          // Otherwise you pick. Everything here is on the list, including the sessions that stayed
          // quiet, because "0 free sessions" is a dead end and a quiet session is sometimes the one
          // you want: a worker that has not been reloaded since this extension changed cannot
          // answer a roll call it does not know about.
          const ordered = [...open, ...here.filter((s: any) => !free.has(s.id))];
          const labels = ordered.map(
            (s: any) => `${s.name ?? "(unnamed)"} ${s.id.slice(0, 8)}${free.has(s.id) ? "" : "  (no answer: child run, paired, gone, or not reloaded)"}`,
          );
          // The goal is a title here, not the goal itself. Yours run to paragraphs of acceptance
          // evidence, and the whole thing above a three-line picker is a wall to read past.
          const picked = await context.ui.select(`which session works on "${firstLine(goal)}"`, labels);
          if (picked === undefined) return; // cancelled, and the notice would say nothing new
          worker = ordered[labels.indexOf(picked)];
        }
      }
      void startPair(worker, goal, context).catch(() => {});
    },
  });

  /**
   * How many verdicts this look has had, and the cut for a real runaway.
   *
   * Session 019ffa73, every look: let_it_run with a true reason, then a second let_it_run with a
   * different true reason, then "This operation was aborted", sixteen times before 11:05Z. The
   * second call is the model signing off, not a loop, and cutting it made an ordinary look end in
   * an error line. So a repeat is answered instead (LET_IT_RUN_AGAIN), and abort() waits for a
   * count no sign-off explains. Session 019ffa5f reached 645 calls, so the cut stays.
   *
   * Only let_it_run reaches nobody, so only it is safe to answer twice. steer and done act every
   * time they are called, and the repeat warning in steer is what covers a duplicate there.
   */
  const RUNAWAY_VERDICTS = 5;
  let verdictsThisLook = 0;
  const endLook = (context: any) => {
    verdictsThisLook += 1;
    if (verdictsThisLook > RUNAWAY_VERDICTS) context.abort();
    return verdictsThisLook === 1;
  };

  pi.registerTool({
    name: "review_goal", label: "Review goal",
    description: "Answer the explicit goal sign-off request using its requestId. Approve trajectory/scope, request further work, or name a human decision. This does not complete the goal or stop supervision.",
    parameters: Type.Object({ requestId: Type.String(), decision: Type.String({ enum: ["approve", "needs_work", "needs_user"] }), reason: Type.String() }),
    execute: async (_id: string, params: { requestId: string; decision: GoalDecision["decision"]; reason: string }) => {
      const review = incomingReview;
      if (state.role !== "supervisor" || !review || review.requestId !== params.requestId) throw new Error("No matching pending goal request");
      if (!["approve", "needs_work", "needs_user"].includes(params.decision) || !params.reason.trim()) throw new Error("A decision and reason are required");
      if (planHash(planText(state.plan!)) !== review.planHash) throw new Error("Plan changed; ask the worker to retry");
      send({ ...review, ...params, t: "goal_decision", to: state.pairedId });
      incomingReview = undefined;
      return { content: [{ type: "text", text: "Goal decision sent. Supervision remains active. End this response." }], terminate: true };
    },
  });

  pi.registerTool({
    name: "worker_view",
    label: "Worker view",
    description: "Read the latest view of the worker session: goal, status, files touched, and recent turns.",
    parameters: Type.Object({}),
    // Guarded like the rest. Unguarded it answered "the worker has not stopped since pairing" to a
    // session with no pairing at all, which read as confirmation to a worker that had wondered
    // whether it was the supervisor.
    execute: async () => {
      if (state.role !== "supervisor") {
        return { content: [{ type: "text", text: "Not supervising, so there is no worker and no view." }], isError: true };
      }
      return { content: [{ type: "text", text: latestView || "No view received yet. The worker has not stopped since pairing." }] };
    },
  });

  pi.registerTool({
    name: "set_goal",
    label: "Set the goal",
    description:
      "Set the goal when the human did not give one. Infer it from the worker's view. This is announced to the human, who can override it.",
    parameters: Type.Object({ goal: Type.String({ description: "One sentence, the outcome the worker must reach." }) }),
    execute: async (_id: string, params: { goal: string }) => {
      if (state.role !== "supervisor") {
        return { content: [{ type: "text", text: "Not supervising." }], isError: true };
      }
      if (state.plan) throw new Error("The plan belongs to pi-goals; steer the worker to propose a plan change");
      state = { ...state, goal: params.goal };
      reviewsSinceGoal = 0;
      save();
      // The tool result records this inferred goal in the supervisor context. The worker needs it too.
      send({ t: "goal", to: state.pairedId, goal: params.goal });
      // Announced, not silent: the supervisor's own reply is what reaches the human's phone.
      ctx?.ui?.notify?.(`goal set by the supervisor: ${params.goal}`, "info");
      return {
        content: [{
          type: "text",
          text: `Goal set to:

<goal>
${params.goal}
</goal>

This is a goal you inferred, not one the human gave you.
Tell them in your reply, quoting it, so they can correct it.`,
        }],
      };
    },
  });

  pi.registerTool({
    name: "steer",
    label: "Steer worker",
    description: TOOL_STEER,
    parameters: Type.Object({ message: Type.String({ description: "One concrete next action, 1 to 3 sentences." }) }),
    execute: async (_id: string, params: { message: string }, _signal: unknown, _update: unknown, context: any) => {
      if (state.role !== "supervisor") {
        return { content: [{ type: "text", text: "Not supervising. Run /supervise <worker> first." }], isError: true };
      }
      // No goal means no basis to steer. Inventing work is the observed failure, so ask instead.
      if (!state.goal.trim()) {
        return { content: [{ type: "text", text: NO_GOAL }], isError: true };
      }
      // Sent either way. Refusing a repeat would be a stopping rule, and a repeat is sometimes
      // right; the supervisor gets told so it can change approach on the next round.
      // Numbered from the run's total, not from the position in the window, so the number here
      // means the same thing as the one in the review nudge and in "that is instruction N".
      const first = state.steerRounds - state.recentSteers.length + 1;
      const repeat = state.recentSteers
        .map((old, i) => ({ old, n: first + i, score: overlap(old, params.message) }))
        .sort((a, b) => b.score - a.score)[0];

      send({ t: "directive", to: state.pairedId, text: params.message });
      state = {
        ...state,
        steerRounds: state.steerRounds + 1,
        recentSteers: [...state.recentSteers, params.message].slice(-STEER_MEMORY),
      };
      save();

      const warning = repeat && repeat.score >= OVERLAP_WARN
        ? `\nThis says much the same as instruction ${repeat.n}: "${repeat.old}"\nIf the next view shows nothing new, say what evidence makes repeating it worth another round, or change approach.`
        : "";
      endLook(context);
      return { content: [{ type: "text", text: `${STEER_ACK(state.steerRounds, state.pairedId)}${warning}` }] };
    },
  });

  /**
   * The third verdict, and the one that stops a fabricated steer.
   *
   * Observed 2026-08-12: with only steer and done on offer, a supervisor with nothing to say wrote
   * "the harness demands a tool call ... the least-bad option is a steer that adds something new",
   * ran a command that printed nothing, then reported a job was at "turn 47 of 80". The real log
   * said 75 of 80. Forcing a verdict every look is what bought that number.
   */
  pi.registerTool({
    name: "let_it_run",
    label: "Let the worker run",
    description: TOOL_LET_IT_RUN,
    parameters: Type.Object({ reason: Type.String({ description: "Quote the exact worker-view text supporting no instruction. Do not infer future work or worker state." }) }),
    execute: async (_id: string, params: { reason: string }, _signal: unknown, _update: unknown, context: any) => {
      if (state.role !== "supervisor") {
        return { content: [{ type: "text", text: "Not supervising." }], isError: true };
      }
      const first = endLook(context);
      return { content: [{ type: "text", text: first ? LET_IT_RUN_ACK(params.reason, workerStopped) : LET_IT_RUN_AGAIN }] };
    },
  });

  pi.registerTool({
    name: "done",
    label: "Finish supervision",
    description: TOOL_DONE,
    parameters: Type.Object({ reason: Type.String({ description: "The artifact path and the quoted line that proves it." }) }),
    execute: async (_id: string, params: { reason: string }, _signal: unknown, _update: unknown, context: any) => {
      if (state.role !== "supervisor") {
        return { content: [{ type: "text", text: "Not supervising." }], isError: true };
      }
      if (state.plan && (incomingReview || /^\s*(?:\d+\.|[-*])\s*\[[ /]\]\s*goal:/im.test(planText(state.plan)))) throw new Error("Open plan goals remain. Use review_goal for an individual goal request.");
      if (state.plan && /tracked background work:.*unknown|tracked background work:.*(?:processes|subagents): [1-9]/.test(latestView)) throw new Error("Tracked background work is active or unknown");
      // "done" while a delegated tool call has no result is a false completion: the worker settled
      // but its subagent or background job is still spending. This proves only that no tracked
      // tool result is missing. A detached process is invisible to it.
      const pending = latestView.match(/^tool calls with no result: (?!none)(.+)$/m)
        ?? latestView.match(/^child pi processes still running: (?!none)(.+)$/m);
      if (pending) {
        return {
          content: [{ type: "text", text: DONE_BLOCKED(pending[1]) }],
          isError: true,
        };
      }
      send({ t: "done", to: state.pairedId, reason: params.reason });
      const rounds = state.steerRounds;
      reset(`supervision finished: ${params.reason}`, true);
      endLook(context);
      return { content: [{ type: "text", text: `Supervision finished after ${rounds} instructions.` }] };
    },
  });
}
