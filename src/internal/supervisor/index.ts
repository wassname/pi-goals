/**
 * intercom-supervisor: a supervisor pi session watches a worker pi session and steers it.
 *
 * Internal to pi-goals. The package loads this in both sessions; Ready creates the supervisor.
 *
 * Wire: the pi-intercom extension channel carries data without starting a turn, so each side
 * triggers its own turn locally with pi.sendUserMessage. The broker stamps fromSessionId from its
 * own registry, so pairing on that ID cannot be forged by a payload.
 */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type {
  IntercomExtensionChannel,
  IntercomExtensionEvent,
} from "pi-intercom/extension-api.ts";
import { Type } from "typebox";
import { loadBundledIntercom } from "../../intercom.js";
import { type Bootstrap, pendingReply, planHash, planText, type SupervisorBinding, type SupervisorController, validBinding } from "../../supervisor.js";
import { backgroundState } from "./background.js";
import type { GoalDecision, GoalReview, GoalReviewRequest, PlanCompletion } from "./protocol.js";

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
  TOOL_REVIEW_GOAL,
  TOOL_STEER,
  VIEW_PRUNED,
} from "./prompts.js";
import {
  EMPTY_STATE,
  goalReviewWire,
  isWire,
  NAMESPACE,
  OVERLAP_WARN,
  overlap,
  restoreState,
  reviewIdentity,
  STATE_ENTRY,
  STEER_MEMORY,
  type SuperviseState,
  type Wire,
} from "./protocol.js";
import { childPiProcesses } from "./subagents.js";
import { age, buildView, progressKey, sinceLastTurn, turnsSince } from "./view.js";

/** Display metadata is local; a roster timeout must not prevent a worker overview. */
function workerModel(context: Pick<ExtensionContext, "model" | "getContextUsage">): string {
  const model = context.model ? `${context.model.provider}/${context.model.id}` : "unknown";
  const percent = context.getContextUsage?.()?.percent;
  // Unknown after compaction is not zero context use.
  return percent == null ? model : `${model}, ${Math.round(percent)}% of its context used`;
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

/** Unknown extension tools can spawn or mutate indirectly. Only native inspection tools and
 * this module's narrowly owned steering/checkpoint tools are available in supervisor mode. */
const INSPECTION_TOOLS = new Set(["read", "grep", "find", "ls"]);

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

export default function (pi: any, modelReady: () => boolean = () => true, planProgress?: (plan: string) => { completion: PlanCompletion; summary: string }, onPause?: (exit: boolean) => void): SupervisorController {
  let duplicateIntercom = false;
  let channel: IntercomExtensionChannel | undefined;
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
  let attached: ReturnType<typeof pendingReply<SupervisorBinding>> | undefined;
  let outgoingReview: (ReturnType<typeof pendingReply<GoalDecision>> & { review: GoalReview }) | undefined;
  let incomingReview: GoalReviewRequest | undefined;
  let presentedReview: GoalReviewRequest | undefined;
  let supervisorMode = false;
  let peerDisconnected = false;
  let activeAssessment: "view" | "goal" | undefined;
  let assessmentFailure: string | undefined;
  let lastFailure: string | undefined;
  let resuming: ReturnType<typeof pendingReply<boolean>> | undefined;
  let assessmentEmpty = false;
  let routineDirty = false;
  let refreshInFlight = false;
  let advancing = false;
  let checkpointQueued = false;
  let latestCompletion: PlanCompletion | undefined;
  let lastPublishedPlanHash: string | undefined;
  let lookPending = false;
  let publishAgain = false;
  let publishingLeaf: string | number | undefined;
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

  async function compactSupervisor(force = false) {
    if (!modelReady()) throw new Error("Supervisor model unavailable; select with /model before compaction");
    if (compacting) return compacting;
    if (!state.plan || !ctx.isIdle()) return;
    const tokens = ctx.getContextUsage?.()?.tokens;
    const measured = typeof tokens === "number" && Number.isFinite(tokens);
    if (force && measured && tokens <= 20_000) {
      ctx.ui.notify("Supervisor fork is already small; compaction skipped.", "info");
      return;
    }
    const threshold = Math.min(state.plan.compactTokens, Math.max(1, (ctx.model?.contextWindow ?? 200_000) - 20_000));
    if (!force && (!measured || tokens <= threshold)) return;
    compacting = new Promise<void>((resolve, reject) => ctx.compact({
      customInstructions: "Preserve the user's intent, decisions and their reasons, unresolved choices, plan path, and supervisor interventions. You are becoming/remaining the supervisor, not the worker.",
      onComplete: () => resolve(),
      onError: (error: Error) => {
        // Native Pi can retain all recent messages even when total context exceeds our small-fork
        // shortcut (system/tool tokens are not compactable history). This is not a provider failure.
        if (force && error.message === "Nothing to compact (session too small)") {
          ctx.ui.notify("Supervisor fork has no older history eligible for compaction; retaining it unchanged.", "info");
          resolve();
        } else reject(error);
      },
    }));
    showStatus();
    try { await compacting; }
    finally { compacting = undefined; showStatus(); }
  }

  function cancelGoalRequests(reason: string) {
    resuming?.finish(undefined, new Error(reason)); resuming = undefined;
    attached?.finish(undefined, new Error(reason)); attached = undefined;
    outgoingReview?.finish(undefined, new Error(reason)); outgoingReview = undefined;
    if (incomingReview && state.pairedId && channel?.snapshot().connected) send({ t: "goal_cancel", to: state.pairedId, requestId: incomingReview.requestId, bindingId: incomingReview.bindingId });
    incomingReview = undefined;
    presentedReview = undefined;
    checkpointQueued = false;
  }

  async function ready(signal?: AbortSignal, wait = false) {
    if (duplicateIntercom) throw new Error("Multiple Intercom runtimes are loaded. Keep one Intercom installation and reload.");
    if (!modelReady()) throw new Error("Role model unavailable; configure the saved model or explicitly select with /model, then retry.");
    if (!ctx || stopping) throw new Error("Supervisor session is not ready");
    signal?.throwIfAborted();
    if (wait && !channel?.snapshot().connected) {
      const connected = pendingReply<void>(signal, () => {}, 30_000);
      void intercomConnected.then(() => connected.finish());
      await connected.promise;
    }
    if (stopping) throw new Error("Supervisor session ended");
    signal?.throwIfAborted();
    if (!channel?.snapshot().connected || !channel.snapshot().supported) throw new Error("Intercom is unavailable. Enable a compatible Intercom and reload both sessions.");
  }

  function workerPlan(bindingId: string): SupervisorBinding {
    if (!state.plan || bindingId !== state.plan.id) throw new Error("Plan pairing changed or is unavailable");
    if (state.role !== "worker" || !state.pairedId) throw new Error("Supervisor is not paired; use /goals supervisor or turn the steward off");
    return state.plan;
  }

  const controller: SupervisorController = {
    async status(signal) {
      signal?.throwIfAborted();
      if (duplicateIntercom) throw new Error("Multiple Intercom runtimes are loaded. Keep one Intercom installation and reload.");
      const available = !!channel?.snapshot().connected && !!channel.snapshot().supported;
      const live = available ? await channel!.listSessions() : [];
      return { workerId: available ? await resolveOwnId() : ownId, role: state.role, binding: state.plan,
        connected: available && !!state.pairedId && !peerDisconnected && live.some(s => s.id === state.pairedId),
        activity: state.plan?.stopped ? "ended" : state.plan?.paused ? "stopped by user" : compacting ? "compacting" : bootstrapPending ? "starting" : activeAssessment ? "reviewing" : refreshInFlight ? "requesting overview" : state.plan?.active ? "monitoring" : "inactive",
        lastFailure: lastFailure ?? state.plan?.startupFailure };
    },
    pause(exit = false) {
      pauseLocally(exit);
      if (state.plan && state.pairedId) {
        try { send({ t: "plan_pause", to: state.pairedId, bindingId: state.plan.id, exit, pauseId: state.plan.pauseId! }); }
        catch (error) { lastFailure = String(error); }
        ctx.ui.notify("Stopped locally. Peer stop requested but not confirmed; inspect the other pane. Independently running processes are not killed.", "warning");
      }
    },
    async reconnect(signal) {
      await ready(signal);
      if (!state.plan || state.plan.stopped || !state.pairedId) throw new Error("No recoverable pair. Reconnect never creates a supervisor; inspect the recorded pane or select Ready for a new pairing.");
      await rejoinOrDrop();
      signal?.throwIfAborted();
    },
    async resume(bindingId, hash, signal) {
      await ready(signal);
      const plan = workerPlan(bindingId);
      if (plan.stopped) throw new Error("This pairing ended; it cannot be resumed. Review the plan with Ready.");
      if (hash !== planHash(planText(plan))) throw new Error("Plan changed before resume; review it with Ready.");
      if (resuming) throw new Error("Resume already pending");
      const generation = pairingGeneration;
      const pending = pendingReply<boolean>(signal, () => {}, 10_000);
      resuming = pending;
      try {
        send({ t: "plan_resume", to: state.pairedId, bindingId, requestId: pending.requestId, planHash: hash, pauseId: plan.pauseId });
        if (!await pending.promise) throw new Error("Peer rejected resume; inspect its state and the plan.");
        signal?.throwIfAborted();
        if (generation !== pairingGeneration || state.plan?.id !== bindingId || hash !== planHash(planText(state.plan))) throw new Error("Plan or pairing changed during resume");
        state = { ...state, plan: { ...state.plan, paused: false, active: true } }; save();
        startWatch();
      } catch (error) {
        pending.finish(false);
        // A lost acknowledgement must not leave the worker running or the peer silently active.
        controller.pause();
        throw error;
      } finally { if (resuming === pending) resuming = undefined; }
    },
    async prepare(binding, signal) {
      await ready(signal, true);
      if (!validBinding(binding) || binding.workerSession !== ctx.sessionManager.getSessionFile()) throw new Error("Invalid plan binding for this worker session");
      if (state.role !== "none" || state.plan) throw new Error("A supervisor is already associated; stop it before replacing the plan");
      state = { ...state, plan: binding }; save();
    },
    async bootstrap(bootstrap: Bootstrap, signal) {
      await ready(signal, true);
      if (!validBinding(bootstrap.binding) || !bootstrap.workerId) throw new Error("Invalid supervisor bootstrap");
      const binding = { ...bootstrap.binding, ...(state.plan?.id === bootstrap.binding.id ? state.plan : {}), supervisorSession: ctx.sessionManager.getSessionFile() };
      if (!binding.supervisorSession || binding.supervisorSession === binding.workerSession) throw new Error("Supervisor must use a distinct persisted fork");
      if (state.plan?.id === binding.id && state.plan.stopped) throw new Error("This supervisor was stopped. Start a new pairing from the worker.");
      if (state.role === "supervisor" && state.plan?.id === binding.id && state.planInitialized && state.pairedId) {
        await rejoinOrDrop(); return state.plan;
      }
      if (state.plan?.id === binding.id && state.plan.paused) return binding;
      bootstrapPending = true;
      const generation = ++pairingGeneration;
      const cancelled = () => stopping || generation !== pairingGeneration || state.plan?.id !== binding.id || state.plan.stopped || signal?.aborted;
      state = { ...EMPTY_STATE, role: "supervisor", pairedId: bootstrap.workerId, plan: binding, goal: state.plan?.id === binding.id ? state.goal : planText(binding) };
      supervisorMode = true;
      stripWriters(); showSupervisorTools(true); save();
      try {
        await compactSupervisor(true);
        if (cancelled()) throw new Error("Supervisor bootstrap cancelled");
        const worker = (await channel!.listSessions()).find(s => s.id === bootstrap.workerId);
        if (cancelled()) throw new Error("Supervisor bootstrap cancelled");
        if (!worker) throw new Error("The specified worker is no longer connected");
        await startPair(worker, state.goal, ctx, binding);
        return binding;
      } catch (error) {
        if (!stopping && generation === pairingGeneration) {
          const reason = `Supervisor initialization failed: ${String(error)}`.slice(0, 2000);
          lastFailure = reason;
          // Readiness of the terminal is not readiness of the pairing. Notify the
          // worker's attachment wait of this terminal failure before resetting locally.
          try { send({ t: "plan_failed", to: bootstrap.workerId, bindingId: binding.id, sessionFile: binding.supervisorSession, reason }); }
          catch { ctx.ui.notify("Startup failed; the worker could not be notified. Stop startup in the worker pane.", "warning"); }
          reset(reason);
        }
        throw error;
      } finally { bootstrapPending = false; }
    },
    async stop(bindingId) {
      if (!state.plan || bindingId !== state.plan.id) throw new Error("No matching plan pairing to stop");
      const connected = channel?.snapshot().connected && channel.snapshot().supported;
      if (connected) {
        send({ t: "plan_stop", to: "*", bindingId });
        if (state.pairedId) send({ t: "unpair", to: state.pairedId });
      }
      reset("Plan supervision stopped", true);
      if (!connected) throw new Error("Stopped locally; Intercom disconnected so the supervisor may not have received stop. Inspect its recorded pane.");
    },
    async attached(bindingId, signal, expected) {
      await ready(signal);
      if (!state.plan || bindingId !== state.plan.id) throw new Error("Plan pairing changed or is unavailable");
      if (state.plan.startupFailure) throw new Error(state.plan.startupFailure);
      if (expected) {
        if (expected.id !== bindingId || expected.workerSession !== state.plan.workerSession) throw new Error("Startup identity changed");
        state = { ...state, plan: { ...state.plan, supervisorSession: expected.supervisorSession, supervisorPane: expected.supervisorPane } }; save();
      }
      if (state.role === "worker") {
        const live = await channel!.listSessions();
        if (!state.plan || state.plan.id !== bindingId) throw new Error("Plan pairing changed while checking attachment");
        if (state.plan.startupFailure) throw new Error(state.plan.startupFailure);
        if (live.some(s => s.id === state.pairedId)) return state.plan;
      }
      if (attached) throw new Error("Already waiting for the supervisor");
      const pending = pendingReply<SupervisorBinding>(signal, () => { attached = undefined; });
      attached = pending;
      return pending.promise;
    },
    async activate(bindingId, signal) {
      await ready(signal); workerPlan(bindingId);
      if (state.plan?.paused || state.plan?.stopped) throw new Error("Pairing stopped; use explicit /goals resume from the worker.");
      state = { ...state, plan: { ...state.plan!, active: true } }; save();
      send({ t: "plan_activate", to: state.pairedId, bindingId });
      startWatch();
      await publishView(ctx, "Ready selected; worker starting", sentTurns, false, true);
    },
    async review(bindingId, goal, hash, signal) {
      await ready(signal);
      const plan = workerPlan(bindingId);
      if (plan.paused || plan.stopped) throw new Error("Goal work stopped; resume explicitly before sign-off.");
      if (outgoingReview) throw new Error("A goal review is already pending");
      if (!goal || hash !== planHash(planText(plan))) throw new Error("The plan changed before goal review");
      const peer = state.pairedId;
      const generation = pairingGeneration;
      const context = ctx;
      let sent = false;
      const pending = pendingReply<GoalDecision>(signal, () => {
        if (outgoingReview?.requestId === pending.requestId) outgoingReview = undefined;
        if (sent && channel?.snapshot().connected) send({ t: "goal_cancel", to: peer, requestId: pending.requestId, bindingId });
      }, null);
      const review = { requestId: pending.requestId, bindingId, goal, planHash: hash };
      outgoingReview = { ...pending, review };
      // Return the cancellable promise immediately; optional tracker queries must not delay abort.
      void (async () => {
        try {
          const { view } = await captureWorkerView(context, "goal checkpoint", 0);
          if (outgoingReview?.requestId !== pending.requestId) return;
          signal?.throwIfAborted();
          if (stopping || generation !== pairingGeneration || state.pairedId !== peer || peerDisconnected || context.sessionManager.getSessionFile() !== ctx.sessionManager.getSessionFile()) throw new Error("Supervisor checkpoint cancelled while building worker context");
          if (hash !== planHash(planText(workerPlan(bindingId)))) throw new Error("Plan changed while building worker context");
          send(goalReviewWire(peer, review, view));
          sent = true;
        } catch (error) {
          if (outgoingReview?.requestId === pending.requestId) pending.finish(undefined, error instanceof Error ? error : new Error(String(error)));
        }
      })();
      return pending.promise;
    },
  };
  pi.on("session_shutdown", () => {
    stopping = true;
    pairingGeneration++;
    cancelGoalRequests("Session reloaded or ended; retry the goal review");
    clearAssessments();
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
    if (state.plan?.paused) { ctx.ui.setStatus(STATUS_ID, "supervision stopped by user"); return; }
    if (state.role === "none") {
      ctx.ui.setStatus(STATUS_ID, undefined);
      return;
    }
    if (peerDisconnected || !channel?.snapshot().connected) { ctx.ui.setStatus(STATUS_ID, "supervision disconnected"); return; }
    const text = state.role === "supervisor"
      ? compacting ? "compacting supervisor context" : lastFailure ? "assessment failed · /goals status" : refreshInFlight ? "waiting for worker overview" : `watching ${state.steerRounds}${routineDirty ? " · update pending" : ""}`
      : "watched";
    ctx.ui.setStatus(STATUS_ID, ctx.ui.theme.fg("accent", `${EYE} `) + ctx.ui.theme.fg("dim", text));
  }

  function send(message: Wire) {
    if (!channel?.snapshot().connected || !channel.snapshot().supported) throw new Error("Intercom disconnected: no message was sent. Reconnect the existing sessions.");
    channel.publish(state.plan ? { ...message, bindingId: state.plan.id } : message, { audience: "capable" });
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
  function inspectionAllowed(name: string): boolean {
    if (SUPERVISOR_TOOLS.includes(name)) return true;
    return INSPECTION_TOOLS.has(name) && pi.getAllTools().some((tool: any) => tool.name === name && tool.sourceInfo?.source === "builtin");
  }

  pi.on("tool_call", (event: any, context: any) => {
    initializeSession(context);
    if (state.plan?.paused && SUPERVISOR_TOOLS.includes(event.toolName)) return { block: true, reason: "Supervision stopped by user. Resume explicitly from the worker." };
    if (supervisorMode && !inspectionAllowed(event.toolName)) return { block: true, reason: "Supervisor mode is inspection-only. Steer the worker; do not execute, delegate, schedule, or mutate files." };
  });
  pi.on("user_bash", () => {
    if (supervisorMode) return { result: { output: "Supervisor mode is inspection-only. Run commands in the worker pane.", exitCode: 1, cancelled: false, truncated: false } };
  });

  function stripWriters(): string[] {
    const before: string[] = pi.getActiveTools();
    const kept = before.filter((t: string) => inspectionAllowed(t));
    // Remember the names removed, not the whole list. Other extensions add and remove their own
    // tools while supervision runs (pi-context-prune adds context_prune, pi-telegram suspends its
    // own), so restoring a snapshot taken hours ago would silently undo their decisions.
    removedWriters = [...new Set([...removedWriters, ...before.filter((t: string) => !inspectionAllowed(t))])];
    pi.setActiveTools(kept);
    const still = pi.getActiveTools().filter((t: string) => !inspectionAllowed(t));
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
  function pauseLocally(exit: boolean, pauseId: string = randomUUID()) {
    pairingGeneration++;
    if (state.plan) state = { ...state, plan: { ...state.plan, paused: true, active: false, pauseId } };
    // Local state wins even when cancellation cannot be delivered to the peer.
    try { cancelGoalRequests("Stopped by user"); } catch (error) { lastFailure = String(error); }
    clearAssessments();
    clearInterval(watchTimer); clearTimeout(pairTimer);
    watchTimer = undefined; pairTimer = undefined;
    finishPair(new Error("Stopped by user"));
    save();
    onPause?.(exit);
    ctx?.abort();
  }

  async function rejoinOrDrop() {
    if (!modelReady() || duplicateIntercom || bootstrapPending || !state.role || !state.pairedId || (state.plan && state.role === "supervisor" && !state.planInitialized)) return;
    const live = await channel!.listSessions();
    if (state.plan) {
      // Pi session files identify the pair across process restarts; broker IDs identify live peers.
      send({ t: "plan_hello", to: "*", bindingId: state.plan.id, role: state.role as "worker" | "supervisor", sessionFile: ctx.sessionManager.getSessionFile(), paused: state.plan.paused, pauseId: state.plan.pauseId });
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
    if (state.plan?.paused) { showStatus(); return; }
    if (state.role !== "supervisor") {
      // A worker reloaded at the prompt takes no turn, so this is its only chance to start watching.
      startWatch();
      ctx?.ui?.notify?.(`intercom-supervisor: still supervised by ${state.pairedId.slice(0, 8)}`, "info");
      return;
    }
    // The strip lives in the /supervise handler and savedTools is memory, so a resumed supervisor
    // has bash and the edit tools back in a directory the worker is writing to.
    stripWriters();
    // Say the goal and the answer shape again. A /reload is how a changed prompt reaches a running
    // session, and the brief goes out only at pairing, so without this a wording fix needs a fresh
    // pairing and loses the supervisor's memory of its own steers.
    tellSupervisor(REANCHOR(state.goal, state.steerRounds));
    reviewsSinceGoal = 0;
    // Ask for a view rather than wait for one. A supervisor that came back from a crash, a credit
    // failure or a /reload holds a stale picture, and answering from a stale picture is how it
    // invents a fact. Only the worker makes views, so it has to ask, and nobody should have to
    // know that: restarting the session is the whole recovery.
    requestFreshView();
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
    clearAssessments();
    clearTimeout(pairTimer);
    pairTimer = undefined;
    finishPair(new Error(note));
    clearInterval(watchTimer);
    watchTimer = undefined;
    supervisorMode = (state.role === "supervisor" && !!state.plan) || !!ctx?.sessionManager.getBranch().some((entry: any) => entry.type === "custom" && entry.customType === "pi-goals-supervisor");
    if (removedWriters.length && !supervisorMode) {
      pi.setActiveTools([...pi.getActiveTools(), ...removedWriters]); // give back what we took
      removedWriters = [];
    }
    showSupervisorTools(false);
    state = { ...EMPTY_STATE, ...(stoppedPlan ? { plan: stoppedPlan } : {}) };
    latestView = "";
    peerDisconnected = false;
    reviewsSinceGoal = 0;
    lastProgress = "";
    staleReviews = 0;
    sentTurns = 0;
    save();
    ctx?.ui?.notify?.(note, "info");
  }

  function clearAssessments() {
    activeAssessment = undefined;
    assessmentFailure = undefined;
    assessmentEmpty = false;
    routineDirty = false;
    refreshInFlight = false;
    checkpointQueued = false;
    latestCompletion = undefined;
    lastPublishedPlanHash = undefined;
    lookPending = false;
    publishAgain = false;
  }

  function failAssessment(reason: string, includeQueued = true) {
    lastFailure = reason;
    // A failed assessment is not a human-input dependency. Resume on later worker
    // progress/cadence, without retrying the same dirty view from agent_settled.
    routineDirty = false;
    refreshInFlight = false;
    ctx.ui.notify(reason, "error");
    if (incomingReview && (includeQueued || !checkpointQueued)) {
      if (channel?.snapshot().connected) send({ ...reviewIdentity(incomingReview), t: "goal_decision", to: state.pairedId, decision: "needs_work", reason });
      incomingReview = undefined; presentedReview = undefined; checkpointQueued = false;
    }
    activeAssessment = undefined;
    showStatus();
  }

  async function advanceSupervisor() {
    if (stopping || state.plan?.paused || advancing || activeAssessment || !ctx?.isIdle() || !modelReady() || peerDisconnected || !channel?.snapshot().connected || state.role !== "supervisor" || (state.plan && ((!state.plan.active && !incomingReview) || !state.planInitialized))) return;
    advancing = true;
    const generation = pairingGeneration;
    try {
      await compactSupervisor();
      if (stopping || generation !== pairingGeneration || activeAssessment || !ctx.isIdle() || peerDisconnected || !channel?.snapshot().connected) return;
      if (incomingReview && checkpointQueued) {
        const review = incomingReview;
        checkpointQueued = false;
        activeAssessment = "goal";
        assessmentFailure = undefined;
        assessmentEmpty = false;
        latestView = review.view ?? "No worker snapshot was attached to this checkpoint. Inspect the worker source session for evidence.";
        workerStopped = false;
        pi.sendMessage({ customType: "supervisor_checkpoint", display: true, details: { requestId: review.requestId },
          content: `Goal sign-off: ${review.goal}
Inspect the actual result against the agreed outcome, discriminator and evidence. A completed task or existing file is not enough. Give a brief useful judgment, then call review_goal; if the goal is unmet, name the next useful work or check. The fresh evidence judge still checks artifacts independently. This is one goal, not the end of supervision.

Worker context frozen for this checkpoint (not a live view):
${latestView}` },
          { triggerTurn: true, deliverAs: "followUp" });
        return;
      }
      if (incomingReview || refreshInFlight || !routineDirty) return;
      routineDirty = false;
      refreshInFlight = true;
      showStatus();
      send({ t: "look", to: state.pairedId });
    } catch (error) {
      if (generation === pairingGeneration && !stopping) failAssessment(`Supervisor review failed: ${String(error)}`);
    } finally {
      advancing = false;
      // Reconnect/checkpoint handlers may have hit the guard while this obsolete compaction
      // was pending. Re-drive only actual current work, never a same-generation failure loop.
      if (generation !== pairingGeneration && !stopping && ((incomingReview && checkpointQueued) || (!incomingReview && !refreshInFlight && routineDirty))) void advanceSupervisor();
    }
  }

  function requestFreshView(retry = false) {
    if (retry) refreshInFlight = false;
    routineDirty = true;
    void advanceSupervisor();
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
    if (wire.t === "plan_failed" && wire.to === me && state.plan?.id === wire.bindingId && state.plan.supervisorSession === wire.sessionFile && !state.plan.active && attached) {
      lastFailure = wire.reason;
      state = { ...state, plan: { ...state.plan, startupFailure: wire.reason, active: false } }; save();
      attached.finish(undefined, new Error(wire.reason)); attached = undefined;
      return;
    }
    if (wire.t === "plan_stop" && state.role === "supervisor" && state.plan?.id === wire.bindingId && from === state.pairedId) {
      ctx.abort(); reset("Plan supervision stopped", true); return;
    }
    if ((wire.t === "plan_hello" || wire.t === "plan_hello_ack") && state.plan && !state.plan.stopped && !bootstrapPending && (state.role === "worker" || (state.role === "supervisor" && state.planInitialized))) {
      const expected = state.role === "worker" ? state.plan.supervisorSession : state.plan.workerSession;
      if (wire.bindingId !== state.plan.id || wire.role === state.role || wire.sessionFile !== expected || (wire.to !== "*" && wire.to !== me)) return;
      const returning = peerDisconnected;
      peerDisconnected = false;
      state = { ...state, pairedId: from }; save();
      if (wire.paused && (!state.plan?.paused || (wire.pauseId ?? "") > (state.plan.pauseId ?? ""))) pauseLocally(false, wire.pauseId);
      if (wire.t === "plan_hello") send({ t: "plan_hello_ack", to: from, bindingId: wire.bindingId, role: state.role as "worker" | "supervisor", sessionFile: ctx.sessionManager.getSessionFile(), paused: state.plan?.paused, pauseId: state.plan?.pauseId });
      if (state.role === "worker") { attached?.finish(state.plan); attached = undefined; startWatch(); }
      else if (returning) requestFreshView();
      return;
    }
    if (wire.to !== me) return;

    // Collected only while /supervise is waiting, so a late answer lands nowhere and is dropped.
    if (wire.t === "here") {
      rollCall?.add(from);
      return;
    }

    if (wire.t === "pair") {
      if (supervisorMode && state.plan) return;
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
      const plan = wire.plan ? { ...wire.plan, active: state.plan?.active ?? wire.plan?.active, paused: state.plan?.paused ?? wire.plan.paused } : undefined;
      peerDisconnected = false;
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
    if (state.plan && ["view", "look", "directive", "done", "unpair"].includes(wire.t) && wire.bindingId !== state.plan.id) return;
    // Non-plan reloads retain the Intercom ID without a new handshake. Only addressed,
    // role-appropriate traffic from that validated peer restores connectivity, not presence.
    if (peerDisconnected && !state.plan && !stopping && (
      (state.role === "worker" && ["look", "directive", "goal"].includes(wire.t)) ||
      (state.role === "supervisor" && wire.t === "view")
    )) {
      peerDisconnected = false;
      showStatus();
    }
    if (wire.t === "plan_pause" && state.plan) { pauseLocally(wire.exit, wire.pauseId); return; }
    if (wire.t === "plan_resume" && state.role === "supervisor" && state.plan) {
      const accepted = wire.pauseId === state.plan.pauseId && !state.plan.stopped && !!state.planInitialized && !bootstrapPending && modelReady() && wire.planHash === planHash(planText(state.plan));
      if (accepted) { state = { ...state, plan: { ...state.plan, active: true, paused: false } }; lastFailure = undefined; save(); }
      send({ t: "plan_resumed", to: from, bindingId: wire.bindingId, requestId: wire.requestId, accepted });
      return;
    }
    if (wire.t === "plan_resumed" && resuming?.requestId === wire.requestId) { resuming.finish(wire.accepted); return; }
    if (state.plan?.paused && !["goal_cancel", "unpair", "done"].includes(wire.t)) return;
    if (wire.t === "plan_activate") { state = { ...state, plan: { ...state.plan!, active: true } }; save(); return; }
    if (wire.t === "goal_cancel") {
      if (outgoingReview?.requestId === wire.requestId) outgoingReview.finish(undefined, new Error("Supervisor cancelled the review; retry"));
      if (incomingReview?.requestId === wire.requestId) {
        const active = activeAssessment === "goal" && !checkpointQueued;
        incomingReview = undefined; presentedReview = undefined; checkpointQueued = false;
        if (active) ctx.abort();
        else void advanceSupervisor();
      }
      return;
    }
    if (wire.t === "goal_decision") {
      const pending = outgoingReview;
      if (!pending || pending.review.requestId !== wire.requestId || pending.review.goal !== wire.goal || pending.review.planHash !== wire.planHash) return;
      outgoingReview = undefined;
      pending.finish(wire, planHash(planText(state.plan!)) !== wire.planHash ? new Error("Plan changed during supervisor review") : undefined);
      if (lookPending) void publishView(ctx, "requested complete overview", 0, false, false, true).catch(error => ctx.ui.notify(`Worker overview failed: ${String(error)}`, "error"));
      return;
    }
    if (wire.t === "goal_review" && state.role === "supervisor") {
      if (incomingReview || planHash(planText(state.plan!)) !== wire.planHash) {
        send({ ...reviewIdentity(wire), t: "goal_decision", to: from, decision: "needs_work", reason: "Another review is pending or the plan changed; retry." }); return;
      }
      incomingReview = { ...reviewIdentity(wire), view: wire.view };
      checkpointQueued = true;
      if (refreshInFlight) { refreshInFlight = false; routineDirty = true; }
      await advanceSupervisor();
      return;
    }
    if (wire.t === "paired" && state.role === "supervisor") {
      peerDisconnected = false;
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
      if (!state.plan || state.plan.active) await publishView(ctx, "sent because you asked for a view", 0, false, false, true);
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
      if (state.plan && (!state.plan.active || !state.planInitialized)) return;
      if (wire.refreshed) {
        if (!refreshInFlight) { routineDirty = true; return; }
        refreshInFlight = false;
      } else if (refreshInFlight) { routineDirty = true; return; }
      if (activeAssessment || !ctx.isIdle() || advancing || compacting || incomingReview) {
        routineDirty = true;
        return;
      }
      activeAssessment = "view";
      lastFailure = undefined;
      assessmentFailure = undefined;
      assessmentEmpty = false;
      const generation = pairingGeneration;
      const bindingId = state.plan?.id;
      if (state.plan) {
        if (!state.plan.active || !state.planInitialized) return;
        try { await compactSupervisor(); }
        catch (error) { if (generation === pairingGeneration && !stopping) failAssessment(`Supervisor compaction failed: ${String(error)}`); return; }
      }
      if (stopping || generation !== pairingGeneration || state.role !== "supervisor" || from !== state.pairedId || state.plan?.id !== bindingId || peerDisconnected || !channel?.snapshot().connected || (state.plan && !state.plan.active)) return;
      latestView = wire.view;
      latestCompletion = wire.completion;
      showStatus();
      workerStopped = wire.stopped;
      if (!state.plan && reviewsSinceGoal >= GOAL_REVIEW_INTERVAL - 1) tellGoal();
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

  pi.on("agent_end", (event: any) => {
    if (state.role !== "supervisor" || !activeAssessment) return;
    const last = event.messages?.findLast((message: any) => message.role === "assistant");
    // Low-level runs may retry. Only the final settled failure ends a checkpoint.
    assessmentFailure = last?.stopReason === "error" || last?.stopReason === "aborted"
      ? `Supervisor assessment ${last.stopReason}: ${last.errorMessage || "no completed assessment"}` : undefined;
    assessmentEmpty = last?.stopReason === "stop" && (typeof last.content === "string"
      ? !last.content.trim()
      : Array.isArray(last.content) && last.content.every((block: any) => block.type === "thinking" || (block.type === "text" && !block.text?.trim())));
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
    if (state.role !== "supervisor" || state.plan?.paused) return;
    const checkpoint = event.messages.findLast((m: any) => m.customType === "supervisor_checkpoint");
    presentedReview = checkpoint?.details?.requestId === incomingReview?.requestId ? incomingReview : undefined;
    const messages = event.messages.filter((m: any) => m.customType !== "supervisor_plan");
    if (state.plan) messages.unshift({ role: "custom", customType: "supervisor_plan", display: false, timestamp: Date.now(),
      content: `${loadSupervisorPrompt(ctx.cwd).prompt}

You are the supervisor, not the worker. Inspect and advise; do not execute or delegate work.
The human's Ready approved this plan. Give a brief visible progress assessment at every review.

Current canonical plan (${state.plan.planPath}):
${planText(state.plan)}` });
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
    if (state.role === "supervisor" && !state.plan?.paused) {
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
        ctx?.ui?.notify?.("Multiple Intercom runtimes are loaded. Keep one Intercom installation and reload both sessions.", "error");
        return;
      }
      channel = value;
      if (!value.snapshot().connected) return;
      resolveIntercomConnected();
      if (ctx) rejoinOrDrop().catch((err: Error) => debug("rejoin failed", { error: err.message }));
    },
    onEvent: (event: IntercomExtensionEvent) => {
      if (event.type === "connection" && !event.connected) {
        pairingGeneration++; clearAssessments();
        if (state.role === "supervisor") ctx?.abort();
        cancelGoalRequests("Intercom disconnected; retry the checkpoint after reconnecting");
        ctx?.ui?.notify?.("Intercom disconnected. Supervision is paused; no delivery or approval is confirmed. Keep both sessions and reconnect.", "warning");
        if (ctx?.hasUI && state.role !== "none") ctx.ui.setStatus(STATUS_ID, "supervision disconnected");
        return;
      }
      if (event.type === "session_left" && event.sessionId === state.pairedId) {
        pairingGeneration++; clearAssessments();
        peerDisconnected = true;
        if (state.role === "supervisor") ctx?.abort();
        cancelGoalRequests("Supervisor peer disconnected; retry the checkpoint after reconnecting");
        ctx?.ui?.notify?.("Supervision peer disconnected. Retaining the plan and this session for reconnect.", "warning");
        if (ctx?.hasUI) ctx.ui.setStatus(STATUS_ID, "supervision disconnected");
        return;
      }
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
    if (channel) return;
    pi.events.emit(INTERCOM_EXTENSION_REGISTER_EVENT, intercomRegistration);
  }

  pi.events.on(INTERCOM_EXTENSION_REGISTRY_READY_EVENT, () => {
    // A registry announces itself once. If we already registered, another standalone copy loaded.
    if (channel) {
      duplicateIntercom = true;
      ctx?.ui?.notify?.("Multiple Intercom runtimes are loaded. Keep one Intercom installation and reload both sessions.", "error");
      return;
    }
    registerIntercom();
  });
  registerIntercom();

  function initializeSession(context: any) {
    ctx = context;
    if (duplicateIntercom) ctx.ui.notify("Multiple Intercom runtimes are loaded. Keep one Intercom installation and reload both sessions.", "error");
    if (sessionInitialized) return;
    sessionInitialized = true;
    state = restoreState(context.sessionManager.getBranch());
    supervisorMode = state.role === "supervisor" || context.sessionManager.getBranch().some((entry: any) => entry.type === "custom" && entry.customType === "pi-goals-supervisor");
    // A fresh fork may not yet have supervise-state, especially if model restoration paused it.
    if (supervisorMode) stripWriters();
    // Before anything else, because a worker that can see steer and worker_view starts guessing
    // that it is a supervisor. rejoinOrDrop below may still drop the pairing and hide them again.
    showSupervisorTools(state.role === "supervisor");
    showStatus(); // a resumed pairing has no notice to read, so the footer is all you get
    if (channel?.snapshot().connected) {
      resolveIntercomConnected();
      rejoinOrDrop().catch((err: Error) => debug("rejoin failed", { error: err.message }));
    }
  }

  pi.on("session_start", async (event: any, context: any) => {
    initializeSession(context);
    registerIntercom();
    if (!channel) {
      try { await loadBundledIntercom(pi, event, context); }
      catch (error) { context.ui.notify(`Intercom startup failed: ${String(error)}`, "error"); }
    }
    if (supervisorMode) stripWriters();
  });
  pi.on("before_agent_start", async (_event: unknown, context: any) => {
    initializeSession(context);
    registerIntercom();
    if (supervisorMode) stripWriters();
  });

  /** Capture after tracker queries so intervening user direction is included in the frozen view. */
  async function captureWorkerView(context: any, why: string, since: number, starting = false) {
    const background = state.plan ? await backgroundState(pi) : undefined;
    const subagents = state.plan ? [] : await childPiProcesses();
    const entries = context.sessionManager.getBranch();
    const idle = !starting && context.isIdle() && (!background || background.quiet);
    const currentPlan = state.plan ? planText(state.plan) : undefined;
    const progress = currentPlan === undefined ? undefined : planProgress?.(currentPlan);
    const currentPlanHash = currentPlan === undefined ? undefined : planHash(currentPlan);
    const view = buildView({
      goal: state.goal,
      sourceSession: context.sessionManager.getSessionFile?.(),
      status: `${idle ? "stopped" : "working"}, ${why}, no new turn for ${age(sinceLastTurn(entries))}`,
      entries, since,
      stale: state.plan ? undefined : staleReviews,
      subagents,
      model: workerModel(context),
      background: background?.description,
      planReview: currentPlanHash ? `Canonical plan ${currentPlanHash === lastPublishedPlanHash ? "unchanged" : "changed since the previous published view (or first view)"}; read ${state.plan!.planPath} for scope and goal-state changes.\n${progress?.summary ?? "CompleteGoal sign-off tracking unavailable; checked boxes alone do not establish completion."}` : undefined,
    });
    return { view, idle, entries, completion: progress?.completion, currentPlanHash };
  }

  /**
   * Publish what the worker looks like right now. Used at pairing, on a timer and when asked.
   * `since` is the turn the view starts at: the diff for a routine look, 0 when the supervisor
   * needs the whole picture again.
   */
  async function publishView(context: any, why: string, since = sentTurns, onlyIfChanged = false, starting = false, refresh = false) {
    if (refresh) lookPending = true;
    if (state.role !== "worker") return;
    if (!modelReady() || peerDisconnected || outgoingReview || (state.plan && !state.plan.active)) return;
    const leaf = context.sessionManager.getLeafId?.() ?? context.sessionManager.getBranch().length;
    if (publishing) { if (leaf !== publishingLeaf) publishAgain = true; return; }
    publishingLeaf = leaf;
    publishAgain = false;
    const refreshed = lookPending;
    if (refreshed) since = 0;
    publishing = true;
    let published = false;
    const generation = pairingGeneration;
    const bindingId = state.plan?.id;
    const peer = state.pairedId;
    try {
    // Claimed before the await, not after. ps takes long enough that a second timer tick would
    // otherwise start its own look while this one is still waiting.
    lastLook = Date.now();
    const { view, idle, entries, completion, currentPlanHash } = await captureWorkerView(context, why, since, starting);
    if (generation !== pairingGeneration || state.pairedId !== peer || state.plan?.id !== bindingId || stopping || peerDisconnected || outgoingReview) return;
    // A timer look at a worker that has done nothing since the last one wakes the supervisor to read
    // a view it has already read. Session 019ffa73: 13 of 92 verdicts were "check-in with no new
    // turns ... nothing to judge". The supervisor loses nothing by not being asked, because the view
    // is the same view. It is asked anyway after LOOKS_SKIPPED_MAX, since a worker that has not moved
    // for hours is itself worth seeing, and the elapsed seconds in the status line say so.
    if (onlyIfChanged && !refreshed) {
      if (bodyOf(view) === lastViewBody && looksSkipped < LOOKS_SKIPPED_MAX) {
        looksSkipped += 1;
        debug("look skipped, nothing new since the last view", { looksSkipped });
        return;
      }
      looksSkipped = 0;
    }
    send({ t: "view", to: state.pairedId, view, stopped: idle, ...(refreshed ? { refreshed: true } : {}), ...(completion ? { completion } : {}) });
    published = true;
    lastPublishedPlanHash = currentPlanHash;
    if (refreshed) lookPending = false;
    lastViewBody = bodyOf(view);
    modelTurns = 0;
    settledCheck = false;
    sentTurns = turnsSince(entries);
    debug("published view", { why, to: state.pairedId, sentTurns, idle });
    } finally {
      publishing = false;
      // Keep a failed refresh pending for routine progress/the cadence or explicit look. Only a
      // successful publication may drain coalesced work here; failure must not spin in finally.
      if (published && (lookPending || publishAgain) && !outgoingReview && !stopping && !peerDisconnected && channel?.snapshot().connected && state.role === "worker") void publishView(ctx, "worker updated during publication", 0).catch(error => ctx.ui.notify(`Worker overview failed: ${String(error)}`, "error"));
    }
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
        void backgroundState(pi).then(background => { if (background.quiet && ctx.isIdle() && Date.now() - lastLook > 1_000) return publishView(ctx, "tracked background work finished"); }).catch(() => {});
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
      void backgroundState(pi).then(background => { if (background.quiet && ctx.isIdle() && Date.now() - lastLook > 1_000) return publishView(ctx, "tracked background work finished"); }).catch(() => {});
    }
  });

  /** Fires only when no retry, compaction, or queued continuation will run, so the worker is truly done. */
  pi.on("agent_settled", async (_event: unknown, context: any) => {
    ctx = context;
    showStatus();
    debug("agent_settled", { role: state.role, hasChannel: Boolean(channel) });
    if (state.role === "supervisor") {
      const unresolved = (activeAssessment === "goal" && incomingReview && !checkpointQueued) || (activeAssessment === "view" && verdictsThisLook === 0);
      if (activeAssessment && assessmentFailure) failAssessment(assessmentFailure, false);
      else if (unresolved && assessmentEmpty) failAssessment("Supervisor assessment incomplete: empty final response without a verdict. Retry the checkpoint.", false);
      else if (activeAssessment === "goal" && incomingReview && !checkpointQueued) failAssessment("Supervisor checkpoint incomplete: no review_goal decision. Read the visible assessment and retry when ready; prose alone is not an approval or a human-input dependency.", false);
      assessmentFailure = undefined;
      assessmentEmpty = false;
      // Ordinary prose (including questions) is not a transport latch. Respect human pause
      // instructions in context, but keep later views flowing. Only genuinely queued new work
      // can trigger another look here; an idle response never retries itself.
      activeAssessment = undefined;
      await advanceSupervisor();
      return;
    }
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
      const progress = progressKey(context.sessionManager.getBranch());
      staleReviews = progress === lastProgress ? staleReviews + 1 : 0;
      lastProgress = progress;
      await publishView(context, "worker settled");
    } catch (err) {
      // Nothing awaits this handler, so rethrowing would be an unhandled rejection nobody sees,
      // and the supervisor would silently never wake again.
      debug("view publish failed", { error: (err as Error).message });
      context.ui?.notify?.(`intercom-supervisor: could not send the view, ${(err as Error).message}`, "error");
    }
  });

  // ---- supervisor side: one command and three tools ---------------------------------------

  function startPair(worker: any, goal: string, context: any, plan?: SupervisorBinding): Promise<void> {
    if (!channel) throw new Error("intercom-supervisor: intercom is not connected");
    if (state.role !== "none" && !(plan && bootstrapPending && state.pairedId === worker.id && state.plan?.id === plan.id)) throw new Error(`intercom-supervisor: already paired with ${state.pairedId.slice(0, 8)} as ${state.role}`);
    const target = worker.name ?? worker.id.slice(0, 8);
    supervisorMode = true;
    state = { ...EMPTY_STATE, role: "supervisor", pairedId: worker.id, goal, ...(plan ? { plan } : {}) };
    latestView = "";
    peerDisconnected = false;
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
        requestFreshView(true);
        context.ui?.notify?.(`requested a complete view from ${state.pairedId.slice(0, 8)}; waiting for the worker overview`, "info");
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
        requestFreshView();
        context.ui?.notify?.(`goal changed: ${goal}`, "info");
        return;
      }
      if (supervisorMode && state.plan) { context.ui.notify("This is a plan supervisor fork. Recover or start supervision from the worker's Ready flow.", "warning"); return; }
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
    description: TOOL_REVIEW_GOAL,
    parameters: Type.Object({ decision: Type.String({ enum: ["approve", "needs_work", "needs_user"] }), reason: Type.String() }),
    execute: async (_id: string, params: { decision: GoalDecision["decision"]; reason: string }) => {
      const review = incomingReview;
      if (state.role !== "supervisor" || !review || review !== presentedReview) throw new Error("No matching pending goal request");
      if (!["approve", "needs_work", "needs_user"].includes(params.decision) || !params.reason.trim()) throw new Error("A decision and reason are required");
      if (planHash(planText(state.plan!)) !== review.planHash) {
        failAssessment("Plan changed during supervisor review; retry the checkpoint");
        throw new Error("Plan changed; ask the worker to retry");
      }
      send({ ...reviewIdentity(review), decision: params.decision, reason: params.reason, t: "goal_decision", to: state.pairedId });
      tellSupervisor(`Goal assessment — ${review.goal}: ${params.decision}. ${params.reason}`);
      incomingReview = undefined;
      // A human decision blocks its dependent work, not delivery of later worker direction.
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

      if (state.plan && !state.plan.active) throw new Error("The worker has not activated this plan; wait for Ready.");
      if (peerDisconnected) throw new Error("Worker disconnected; no instruction was sent. Reconnect the existing session.");
      send({ t: "directive", to: state.pairedId, text: params.message });
      tellSupervisor(`Advice to worker: ${params.message}`);
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
      if (first) tellSupervisor(`Progress assessment: ${params.reason}`);
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
      if (routineDirty || refreshInFlight) throw new Error("New worker progress awaits a complete overview; do not finish from the older assessment.");
      if (state.plan && (incomingReview || !latestCompletion || latestCompletion.planHash !== planHash(planText(state.plan)) || !latestCompletion.total || latestCompletion.pending > 0)) throw new Error("Open plan goals or unsigned claims remain, or fresh CompleteGoal tracking is unavailable. Use review_goal for an individual goal request; manual checkboxes are not sign-off.");
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
      if (latestCompletion?.inconclusive) tellSupervisor(`${latestCompletion.inconclusive} goal(s) accepted inconclusive under fail-forward policy, not independently verified. Ending supervision does not turn those records into conclusive success.`);
      send({ t: "done", to: state.pairedId, reason: params.reason });
      const rounds = state.steerRounds;
      reset(`supervision finished: ${params.reason}`, true);
      endLook(context);
      return { content: [{ type: "text", text: `Supervision finished after ${rounds} instructions.` }] };
    },
  });
  return controller;
}
