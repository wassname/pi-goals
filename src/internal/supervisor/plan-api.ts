import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

/** Process-local integration; Intercom carries the corresponding peer messages. */
export const PLAN_API_EVENT = "pi-supervise:plan:v1";
export interface PlanBinding {
  id: string;
  planPath: string;
  workerSession: string;
  workerPane: string;
  supervisorPane?: string;
  supervisorSession?: string;
  active?: boolean;
  stopped?: boolean;
  everyTurns: number;
  intervalMs: number;
  compactTokens: number;
}
export interface GoalReview {
  requestId: string;
  bindingId: string;
  goal: string;
  planHash: string;
}
export interface GoalDecision extends GoalReview {
  decision: "approve" | "needs_work" | "needs_user";
  reason: string;
}
export type PlanWire =
  | { t: "plan_hello" | "plan_hello_ack"; to: string; bindingId: string; role: "worker" | "supervisor"; sessionFile: string }
  | ({ t: "goal_review"; to: string } & GoalReview)
  | ({ t: "goal_decision"; to: string } & GoalDecision)
  | { t: "goal_cancel"; to: string; requestId: string; bindingId: string }
  | { t: "plan_update"; to: string; bindingId: string }
  | { t: "plan_activate" | "plan_stop"; to: string; bindingId: string };
export interface PlanApiRequest {
  version: 1;
  method: "prepare" | "bootstrap" | "attached" | "activate" | "status" | "review" | "update" | "stop";
  binding?: PlanBinding;
  bindingId?: string;
  workerId?: string;
  goal?: string;
  planHash?: string;
  signal?: AbortSignal;
  handled?: boolean;
  resolve(value: unknown): void;
  reject(error: Error): void;
}
export function validBinding(value: unknown): value is PlanBinding {
  if (!value || typeof value !== "object") return false;
  const b = value as PlanBinding;
  return [b.id, b.planPath, b.workerSession, b.workerPane].every(v => typeof v === "string" && v.length > 0)
    && [b.everyTurns, b.intervalMs, b.compactTokens].every(v => Number.isSafeInteger(v) && v > 0);
}
export function planText(binding: PlanBinding): string {
  return readFileSync(binding.planPath, "utf8");
}
export function planHash(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}
export function validPlanWire(value: any): value is PlanWire {
  if (!value || typeof value.to !== "string" || typeof value.bindingId !== "string") return false;
  if (value.t === "plan_hello" || value.t === "plan_hello_ack") return ["worker", "supervisor"].includes(value.role) && typeof value.sessionFile === "string";
  if (value.t === "plan_update" || value.t === "plan_activate" || value.t === "plan_stop") return true;
  if (typeof value.requestId !== "string") return false;
  if (value.t === "goal_cancel") return true;
  if (typeof value.goal !== "string" || typeof value.planHash !== "string") return false;
  if (value.t === "goal_review") return true;
  return value.t === "goal_decision" && ["approve", "needs_work", "needs_user"].includes(value.decision) && typeof value.reason === "string";
}

/** A wait owns its cancellation and deadline; a timeout never means approval. */
export function pendingReply<T>(signal: AbortSignal | undefined, cancel: () => void, timeoutMs = 600_000) {
  let finish!: (value?: T, error?: Error) => void;
  const promise = new Promise<T>((resolve, reject) => {
    let settled = false;
    const abort = () => finish(undefined, new Error("Supervisor request cancelled"));
    const timer = setTimeout(() => finish(undefined, new Error("Supervisor request timed out; retry or turn the steward off")), timeoutMs);
    finish = (value, error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      if (error) { cancel(); reject(error); } else resolve(value as T);
    };
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) queueMicrotask(abort);
  });
  return { requestId: randomUUID(), promise, finish };
}
