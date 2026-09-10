# MoA synthesis — pi-goals simplification and robustness

- question: reduce lifecycle complexity without removing the visible two-session supervisor, explicit plan approval, or evidence-based sign-off.
- sources: [brief](brief.md), DeepSeek V4 Flash advisor [report](deepseek-v4-flash.md), Kimi K3 advisor [report](kimi-k3.md), plus local transcript usage totals collected after the briefs.
- epistemic status: the two advisors were independently prompted from the same brief. Agreement is useful for hypothesis generation, not confirmation. The suggested checks below are not yet run.

## Shared hypotheses

| Hypothesis | Evidence in the reports | What is observed | Cheapest discriminator |
|---|---|---|---|
| Multiple compaction decision points create avoidable seams | Kimi: “Compaction is triggered from **at least four places**”; DeepSeek proposes deleting supervisor startup compaction | Worker pre-fork, supervisor startup, supervisor settled-turn, and Pi default auto-compaction exist. A short Ready path showed a visible no-op error before the threshold fix. | Record caller, known token count, and result for each `ctx.compact` call in one isolated Herdr lifecycle. |
| Incident-driven guards have accumulated overlapping failure policy | Kimi: “Every recorded fix is additive”; it proposes a failure-classification inventory | Recent fixes added hello retry, queued steer, solo fallback, sign-off blocks, and threshold skip. It is not yet established that any two are redundant. | Table every failure site by event, durable state, action, user message, and retry/terminal condition. Merge only duplicate rows. |
| Supervisor narration on disconnect is partly a prompt problem | Kimi: “there is no cheap, sanctioned ‘no change, waiting’ act”; DeepSeek predicts a replay/narration fixed point | One field report showed repeated long narration when a steer could not reach the worker. The cause is not established. | Kill a worker in a test pair, queue one steer, compare supervisor output over fixed turns with and without one line explicitly permitting a short “waiting for worker reconnect” status. |
| Re-injecting a full plan duplicates durable state | Kimi: “Plan-by-pointer instead of plan-by-copy on resync” | The plan is on disk and the supervisor has read tools; the current prompt deliberately repeats the complete active plan after startup/compaction. | Pointer-and-hash variant in a planted-deviation UAT; check that the supervisor still finds the deviation. |
| A shared 100k threshold may not measure the intended property | Kimi: “supervisor’s value is judgment per token”; DeepSeek calls 100k un-sourced | The code uses 100k for both sessions. Local overnight totals show that lower supervisor token volume did not imply lower cost. | Same large-context UAT with custom settled-turn trigger enabled versus disabled; compare evidence recall and cost. |

## Corrections to advisor claims

- DeepSeek’s claim that every post-compaction append flips the supervisor marker is too broad. The current code filters to `message | compaction`, so custom handshake/state entries do not affect it. Ordinary message entries can still matter.
- DeepSeek’s claim that a genuine compaction failure is swallowed is not supported by the code: only errors beginning `Already compacted` or `Nothing to compact` resolve; other errors reject.
- Removing the 100k threshold and accepting no-op errors would reintroduce the user-visible short-context error that the post-fix Herdr UAT no longer shows. Do not adopt that simplification without a way to suppress Pi’s own error display.

## Usage observation from two verified overnight pairs

Usage totals include cache reads.

| Pair | Worker cost / total tokens / output | Supervisor cost / total tokens / output | Observation |
|---|---:|---:|---|
| `suppressed-activations` | $39.99 / 359.8M / 1.82M | $53.59 / 40.0M / 102k | Supervisor used ~9× fewer total tokens but cost more. |
| `LUCID3_wikit` | $7.00 / 311.3M / 362k | $60.94 / 191.4M / 371k across two supervisor sessions | Supervisor output was about worker output and cost ~9× more. |

This supports measuring output/cost per useful review, not using only a context threshold as a proxy for cheap supervision.

## Candidate reductions, without choosing one

1. **Measure compaction ownership before deleting a trigger.** The log-only census can show whether worker pre-fork plus Pi default makes supervisor startup compaction unnecessary in all supported lifecycle paths. If yes, delete that startup decision rather than adding more guards.
2. **Write a failure table before a central classifier.** A generic `{ transient, permanent, cancelled }` abstraction might simplify the code, but it might also hide semantically different outcomes. The table is cheaper and can identify exact deletions first.
3. **Permit a one-line waiting recap during a known absent worker.** This is a prompt-only experiment. It preserves visible supervisor judgment while testing whether it removes the repeated narration report.
4. **Test plan-by-pointer; do not assume it is safe.** Full plan repeat is currently a deliberate fidelity choice. A pointer/hashing test should establish whether the supervisor really reads the plan before replacing the copy.
5. **Keep the current short-context compaction skip.** It has real UAT evidence and does not depend on `pi-better-compaction` or custom-compaction internals.

## Highest-information next check

Run the **compaction census** first. It is the smallest change, works with core Pi events regardless of installed compaction extensions, and distinguishes “we have duplicate manual compaction” from “each trigger covers a distinct lifecycle.” It should record facts, not change policy.

-- PI[gpt-5.6-terra]
