/**
 * What the two sessions say to each other over the pi-intercom extension channel.
 *
 * The channel never enters a transcript and never starts a turn, so each side triggers its own
 * turn locally with pi.sendUserMessage after it receives one of these.
 */

import { type PlanBinding, type PlanWire, validBinding, validPlanWire } from "./plan-api.js";

export const NAMESPACE = "wassname/pi-intercom-supervisor/v1";

// No round cap, no budget, on purpose. Supervision runs until the human stops it with
// /supervise stop, because premature stopping is the failure this whole thing exists to prevent
// (wassname's SUPERVISOR.md, citing arXiv:2410.07095: 8.7% vs 0.8% on MLE-bench).

export type Wire = PlanWire
  /** Roll call, broadcast, so "to" is the wildcard rather than a session. Only /supervise sends it. */
  | { t: "who"; to: "*" }
  /** The answer to a roll call: I load this extension, I am free, and I am not a child run. */
  | { t: "here"; to: string }
  | { t: "pair"; to: string; goal: string; plan?: PlanBinding }
  | { t: "paired"; to: string; plan?: PlanBinding }
  | { t: "goal"; to: string; goal: string }
  /** stopped: the worker settled, so this is a decision point. false: a check in mid-turn. */
  | { t: "view"; to: string; view: string; stopped: boolean }
  /** Supervisor asks for a view now. Its own turn cannot make one: the worker publishes them. */
  | { t: "look"; to: string }
  | { t: "directive"; to: string; text: string }
  | { t: "done"; to: string; reason: string }
  | { t: "unpair"; to: string };

/** Validates the field each kind carries, so a malformed peer cannot inject "[supervisor] undefined". */
export function isWire(payload: unknown): payload is Wire {
  if (typeof payload !== "object" || payload === null) return false;
  if (validPlanWire(payload)) return true;
  const { t, to, goal, view, stopped, text, reason, plan } = payload as Record<string, unknown>;
  if ((t === "pair" || t === "paired") && plan !== undefined && !validBinding(plan)) return false;
  if (typeof to !== "string") return false;
  if (t === "pair" || t === "goal") return typeof goal === "string";
  if (t === "view") return typeof view === "string" && typeof stopped === "boolean";
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
  plan?: PlanBinding;
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
