# Question

How can `pi-goals` become simpler and more robust while preserving the recorded user preferences, especially around compaction, a visible supervisor, recovery, and retained worker/supervisor context? Propose architectural reductions and discriminating checks. Do not choose a winner.

Mode: independent scientific brainstorm.

Reconstruct the situation from the supplied evidence. Propose distinct mechanisms, including an implementation error, an objective or gradient mismatch, and an unintended learning dynamic when relevant. For each, give a falsifiable prediction and the cheapest discriminating check. State what is observed versus inferred. Do not choose a winner.

## Observed facts

1. The product is one implementation worker Pi session plus a visible, separate supervisor Pi session in a Herdr pane. The supervisor is supposed to retain high-level judgment cheaply, while the worker keeps full context.
2. User preferences in `AGENTS.md` say: supervisor messages and thinking must be visible; it should supervise autonomously, inspect actual evidence, steer through the worker rather than take over implementation, preserve normal tools/extensions, and add short judgmental recaps rather than repeated unchanged status.
3. The worker has an explicit plan state with `planning | working`, `supervised | solo`, an approval binding, plan version, sign-offs, a model role manager, and pi-intercom handshake/recovery.
4. Recent fixes added: safe bare `/goals` menu; explicit `/goals plan <objective>` replacement; bounded hello retry (initial plus two retries); retained newest disconnected steer; complete signed-off plans remain paired; loud solo fallback only after an approved plan and supervisor failure; `CompleteGoal` blocked in solo.
5. Current pre-fork behavior: if worker context tokens are known below 100k, no manual compaction occurs. At or above 100k, worker calls core `ctx.compact(customInstructions)` before spawning the supervisor fork. The supervisor sees inherited compaction and skips a second startup compaction. Unknown usage attempts compaction and accepts Pi’s `Already compacted` / `Nothing to compact` errors as benign.
6. Current supervisor also calls core `ctx.compact` on its own settled turns at 100k. The code only uses the Pi API and ordinary compaction events; it does not depend on `pi-better-compaction` internals.
7. A real isolated Herdr UAT with `pi-better-compaction` loaded completed Ready → visible supervisor → worker artifact → supervisor verification/approval → worker CompleteGoal. Before the short-context threshold skip, Pi visibly printed `Error: Compaction failed: Nothing to compact (session too small)` despite continuation; the threshold skip removed that observation in the rerun.
8. Field report: a supervisor attempted to send an overnight instruction after the worker disconnected, generated repeated long status narration, and could not deliver. The new code keeps only the latest instruction and replays it after reconnect, but an ended worker session still requires reload/restart to return.
9. Field report: worker provider rate limits can appear stuck; supervisor compaction can time out. A timeout is not proof of a permanent failure. The chosen policy preserves the plan and makes an eventual solo fallback loud; it must not infer approval from a draft, cancellation, plan change, or worker model error.
10. User sometimes uses `pi-better-compaction` and custom compaction extensions. Avoid assumptions about their internal state or adding another compaction framework.

## Short relevant excerpts

> “the hope is we can have a smart supervisor like you, with judgment and context. But it doesn't use many tokens as it checks in and sees an overview.” — project `AGENTS.md`

> “all supervisor thinking and messages should be visible.” — project `AGENTS.md`

> “Keep brief visible recaps that add judgment rather than repeat unchanged status.” — project `AGENTS.md`

> “Each review repeats the short supervisor opening and current plan outcome … Startup and compaction repeat the longer role prompt and full active plan before appendices/history.” — project `AGENTS.md`

> `compactApprovedWorker`: skip known `< 100k`; otherwise `ctx.compact({ customInstructions: workerCompaction(...) })`; accept `Already compacted` / `Nothing to compact`. — `src/index.ts`

> Supervisor startup skips compaction if inherited context ends in a `compaction` entry or known tokens are below 100k. — `src/supervisor-session.ts`

## Constraints

- Keep two visible sessions and a separate read-only-by-role supervisor; do not replace it with a stateless subagent.
- Preserve explicit plan approval and evidence/sign-off checks.
- Prefer deletion and one source of truth over new modes, retries, background services, or option matrices.
- Do not silently substitute a model or pretend delivery/recovery succeeded.
- Do not prescribe a particular queue, research setup, or compaction extension.
- Suggestions must be testable in a small isolated Herdr scenario and should identify what can be removed.
