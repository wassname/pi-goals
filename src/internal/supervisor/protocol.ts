/**
 * What the two sessions say to each other over the pi-intercom extension channel.
 *
 * The channel never enters a transcript and never starts a turn, so each side triggers its own
 * turn locally with pi.sendUserMessage after it receives one of these.
 */

import { type SupervisorBinding, validBinding } from "../../supervisor.js";
import { MAX_VIEW_BYTES } from "./view.js";

/** Compact completion bookkeeping from the worker, bound to the exact plan it observed. */
export interface PlanCompletion {
  planHash: string;
  total: number;
  pending: number;
  inconclusive: number;
}
function validCompletion(value: any): value is PlanCompletion {
  return !!value && typeof value.planHash === "string" && [value.total, value.pending, value.inconclusive].every(n => Number.isSafeInteger(n) && n >= 0) && value.pending + value.inconclusive <= value.total;
}

export interface GoalReview {
  requestId: string;
  bindingId: string;
  goal: string;
  planHash: string;
}
/** Frozen worker context travels only with the request, never with a decision. */
export interface GoalReviewRequest extends GoalReview {
  view?: string;
}
export function reviewIdentity({ requestId, bindingId, goal, planHash }: GoalReview): GoalReview {
  return { requestId, bindingId, goal, planHash };
}

/** Intercom measures serialized payload bytes, including JSON escapes and checkpoint identity. */
export function goalReviewWire(to: string, review: GoalReview, view: string): PlanWire {
  const payload = { t: "goal_review" as const, to, ...reviewIdentity(review), view };
  const fits = (value: string) => Buffer.byteLength(value, "utf8") <= MAX_VIEW_BYTES && Buffer.byteLength(JSON.stringify({ ...payload, view: value }), "utf8") <= 16 * 1024;
  if (fits(view)) return payload;
  const marker = "\n[checkpoint view cut to fit the channel; inspect the worker source session for omitted detail]\n";
  if (!fits(marker)) throw new Error("Goal checkpoint identity is too large for the 16 KiB Intercom channel");
  const chars = Array.from(view);
  let low = 0; let high = chars.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (fits(chars.slice(0, middle).join("") + marker)) low = middle;
    else high = middle - 1;
  }
  return { ...payload, view: chars.slice(0, low).join("") + marker };
}

export interface GoalDecision extends GoalReview {
  decision: "approve" | "needs_work" | "needs_user";
  reason: string;
}
export type PlanWire =
  | { t: "plan_hello" | "plan_hello_ack"; to: string; bindingId: string; role: "worker" | "supervisor"; sessionFile: string; paused?: boolean; pauseId?: string }
  | { t: "plan_pause"; to: string; bindingId: string; exit: boolean; pauseId: string }
  | { t: "plan_resume"; to: string; bindingId: string; requestId: string; planHash: string; pauseId?: string }
  | { t: "plan_resumed"; to: string; bindingId: string; requestId: string; accepted: boolean }
  | ({ t: "goal_review"; to: string } & GoalReviewRequest)
  | ({ t: "goal_decision"; to: string } & GoalDecision)
  | { t: "goal_cancel"; to: string; requestId: string; bindingId: string }
  | { t: "plan_activate" | "plan_stop"; to: string; bindingId: string };
export function validPlanWire(value: any): value is PlanWire {
  if (!value || typeof value.to !== "string" || typeof value.bindingId !== "string") return false;
  if (value.t === "plan_hello" || value.t === "plan_hello_ack") return ["worker", "supervisor"].includes(value.role) && typeof value.sessionFile === "string" && (value.paused === undefined || typeof value.paused === "boolean") && (value.pauseId === undefined || typeof value.pauseId === "string");
  if (value.t === "plan_pause") return typeof value.exit === "boolean" && typeof value.pauseId === "string";
  if (value.t === "plan_resume") return typeof value.requestId === "string" && typeof value.planHash === "string" && (value.pauseId === undefined || typeof value.pauseId === "string");
  if (value.t === "plan_resumed") return typeof value.requestId === "string" && typeof value.accepted === "boolean";
  if (value.t === "plan_activate" || value.t === "plan_stop") return true;
  if (typeof value.requestId !== "string") return false;
  if (value.t === "goal_cancel") return true;
  if (typeof value.goal !== "string" || typeof value.planHash !== "string") return false;
  if (value.t === "goal_review") return value.view === undefined || (typeof value.view === "string" && Buffer.byteLength(value.view, "utf8") <= MAX_VIEW_BYTES);
  return value.t === "goal_decision" && ["approve", "needs_work", "needs_user"].includes(value.decision) && typeof value.reason === "string";
}



export const NAMESPACE = "wassname/pi-intercom-supervisor/v1";

// No round cap, no budget, on purpose. Supervision runs until the human stops it with
// /supervise stop, because premature stopping is the failure this whole thing exists to prevent
// (wassname's SUPERVISOR.md, citing arXiv:2410.07095: 8.7% vs 0.8% on MLE-bench).

export type Wire = (PlanWire
  /** Roll call, broadcast, so "to" is the wildcard rather than a session. Only /supervise sends it. */
  | { t: "who"; to: "*" }
  /** The answer to a roll call: I load this extension, I am free, and I am not a child run. */
  | { t: "here"; to: string }
  | { t: "pair"; to: string; goal: string; plan?: SupervisorBinding }
  | { t: "paired"; to: string; plan?: SupervisorBinding }
  | { t: "goal"; to: string; goal: string }
  /** stopped: the worker settled, so this is a decision point. false: a check in mid-turn. */
  | { t: "view"; to: string; view: string; stopped: boolean; refreshed?: boolean; completion?: PlanCompletion }
  /** Supervisor asks for a view now. Its own turn cannot make one: the worker publishes them. */
  | { t: "look"; to: string }
  | { t: "directive"; to: string; text: string }
  | { t: "done"; to: string; reason: string }
  | { t: "unpair"; to: string }) & { bindingId?: string };

/** Validates the field each kind carries, so a malformed peer cannot inject "[supervisor] undefined". */
export function isWire(payload: unknown): payload is Wire {
  if (typeof payload !== "object" || payload === null) return false;
  if (validPlanWire(payload)) return true;
  const { t, to, goal, view, stopped, refreshed, text, reason, plan, completion } = payload as Record<string, unknown>;
  if ((t === "pair" || t === "paired") && plan !== undefined && !validBinding(plan)) return false;
  if (typeof to !== "string") return false;
  if (t === "pair" || t === "goal") return typeof goal === "string";
  if (t === "view") return typeof view === "string" && typeof stopped === "boolean" && (refreshed === undefined || typeof refreshed === "boolean") && (completion === undefined || validCompletion(completion));
  if (t === "directive") return typeof text === "string" && text.trim().length > 0;
  if (t === "done") return typeof reason === "string";
  return t === "unpair" || t === "paired" || t === "look" || t === "who" || t === "here";
}

/**
 * Words two instructions share, over the words either uses. Stopwords and short words dropped.
 *
 * Six remembered instructions do not stop repetition, because the same order rephrased reads as
 * new. This catches the rephrasing that shares vocabulary; it cannot catch a true paraphrase.
 */
export function overlap(a: string, b: string): number {
  const words = (s: string) =>
    new Set(
      s
        .toLowerCase()
        .split(/[^a-z0-9_./-]+/)
        .filter((w) => w.length > 3 && !STOPWORDS.has(w)),
    );
  const [x, y] = [words(a), words(b)];
  if (!x.size || !y.size) return 0;
  const shared = [...x].filter((w) => y.has(w)).length;
  return shared / (x.size + y.size - shared);
}

const STOPWORDS = new Set([
  "then", "with", "that", "this", "from", "into", "your", "each", "have", "then", "should", "please",
  "make", "sure", "also", "them", "they", "what", "when", "here", "there", "which", "will", "would",
]);

/**
 * Two instructions sharing this much vocabulary get flagged back to the supervisor.
 *
 * Measured on rewordings of one instruction: about 0.44. On two different instructions: under 0.2.
 * A true paraphrase that shares no words scores 0 and slips through, so this is a floor on
 * repetition, not a bound.
 */
export const OVERLAP_WARN = 0.4;

export interface SuperviseState {
  role: "none" | "worker" | "supervisor";
  /** Intercom session ID of the other side. The broker stamps this, so it cannot be forged. */
  pairedId: string;
  goal: string;
  steerRounds: number;
  /** Recent steer texts, so the supervisor can see repetition after its own context is compacted. */
  recentSteers: string[];
  /** Optional pi-goals integration. Standalone supervision keeps its original policy. */
  plan?: SupervisorBinding;
  /** Supervisor bootstrap completed and the worker acknowledged this plan pairing. */
  planInitialized?: boolean;
}

export const EMPTY_STATE: SuperviseState = {
  role: "none",
  pairedId: "",
  goal: "",
  steerRounds: 0,
  recentSteers: [],
};

/** How many past steers to keep and show back. Enough to spot a loop, small enough to stay cheap. */
export const STEER_MEMORY = 6;

/** Session entry type used to persist state, so a compaction or reload cannot reset the count. */
export const STATE_ENTRY = "supervise-state";

/** Rebuild state from session entries. The last one written wins. */
export function restoreState(entries: Array<{ type: string; customType?: string; data?: unknown }>): SuperviseState {
  let state = EMPTY_STATE;
  for (const entry of entries) {
    if (entry.type === "custom" && entry.customType === STATE_ENTRY && entry.data) {
      // Merge over the defaults so a record written before a field existed still loads.
      state = { ...EMPTY_STATE, ...(entry.data as Partial<SuperviseState>) };
    }
  }
  return state;
}
