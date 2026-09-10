# MoA Advisor — pi-goals simplicity & robustness brainstorm

Independent advisor note. No winner chosen. Quotations are from the supplied brief (project `AGENTS.md`, `src/index.ts`, `src/supervisor-session.ts`, field reports).

## 1. Reconstructed situation

**Observed (from the brief's numbered facts and quotes, treated as evidence):**

- Two visible sessions: one worker, one supervisor fork, linked by pi-intercom, with explicit plan state (`planning | working`, `supervised | solo`), approval binding, sign-offs (fact 1, 3).
- Compaction is triggered from **at least four places**: worker pre-fork `compactApprovedWorker` at ≥100k known tokens; supervisor startup (skipped "if inherited context ends in a `compaction` entry or known tokens are below 100k"); supervisor settled turns at 100k; and Pi's own default auto-compaction (fact 5, 6; code comments confirm "Pi's default auto-compaction is unchanged").
- A real UAT completed the full Ready → supervise → approve → CompleteGoal loop (fact 7). Pi printed `Error: Compaction failed: Nothing to compact (session too small)` **despite continuation**; the threshold skip later removed the message.
- Two field failures: undeliverable overnight steer produced "repeated long status narration" (fact 8); provider rate limits / compaction timeouts "can appear stuck" and "a timeout is not proof of a permanent failure" (fact 9).
- Recent fixes are all **additions**: bounded hello retry, retained newest disconnected steer, loud solo fallback, blocked `CompleteGoal` in solo, threshold skip (fact 4, 5).

**Inferred (not in the facts; flagged as inference):**

- (I1) Each field incident produced a new guard and none removed a mechanism; the fix list in fact 4 is monotone-increasing in special cases.
- (I2) The "Nothing to compact" error was cosmetic in the observed UAT — the session continued — so the threshold skip fixed a *scary message*, not a functional defect. This is inference from "despite continuation" in fact 7.
- (I3) The supervisor's narration loop suggests its prompt rewards visible output and offers no cheap "nothing changed" action; fact 8 alone doesn't prove the cause.

## 2. Candidate mechanisms (distinct; not ranked)

### M1 — Implementation error: multiple compaction owners with inconsistent preconditions
The pair has worker pre-fork compaction, supervisor startup compaction, supervisor settled-turn compaction, and Pi auto-compaction, coordinated only by a shared magic constant (100k) and string-matched benign errors (`/^(Already compacted|Nothing to compact)/`). Unknown token counts fall through to "attempt compaction and accept errors," which is a third implicit policy. The observed `Error: Compaction failed: Nothing to compact (session too small)` is the visible seam where two owners disagreed about whether compaction was needed.

- **Observed:** four trigger sites; the benign-error regex; the UAT error message; the threshold skip removing it.
- **Inferred:** that these sites can race or double-compact in ways not yet observed (e.g., supervisor settled-turn compaction firing while the worker is mid-`compactApprovedWorker` on reconnect).
- **Falsifiable prediction:** in an instrumented UAT, the count of `ctx.compact` calls per plan lifecycle exceeds 1 for at least one session, and at least one call is a no-op (`Already compacted` / `Nothing to compact`).
- **Cheapest discriminating check:** add a one-line log at every `ctx.compact` call site (caller, known tokens, result). Rerun the existing small Herdr UAT. Cost: minutes; no behavior change. If every lifecycle shows exactly one effective compaction, M1 is weakened.

### M2 — Objective mismatch: a fixed token threshold as proxy for "cheap judgment"
The recorded preference is "it doesn't use many tokens as it checks in and sees an overview." The implemented proxy is a hard 100k constant applied to *both* sessions. But the supervisor's value is judgment per token, not tokens below a ceiling: a supervisor compacted at 100k on a 1M-context model loses judgment-bearing detail for no benefit, while a 100k threshold on a 128k worker model may already be late. The threshold encodes one model's window into policy for all models.

- **Observed:** `COMPACT_AT_TOKENS` constant; the AGENTS.md quote; "it does not depend on `pi-better-compaction` internals" (fact 6); the constraint not to "silently substitute a model."
- **Inferred:** that the 100k value was tuned to a specific model/context and is not derived from the stated objective.
- **Falsifiable prediction:** the supervisor's recap quality (human-rated against "recaps that add judgment rather than repeat unchanged status") is measurably worse after a 100k-triggered compaction on a large-window model than with Pi's default auto-compaction left alone.
- **Cheapest discriminating check:** in the isolated UAT, run the same scripted plan twice on a large-window model — once with the 100k supervisor trigger disabled, once enabled — and diff what the supervisor "knows" afterward (e.g., ask it three fixed questions about earlier evidence). One scenario, two runs. If answers are equivalent, the threshold is buying nothing there and M2 is supported.

### M3 — Development-loop dynamic: incident-driven accretion of guards
Every recorded fix is additive (fact 4), while the stated constraint is "Prefer deletion and one source of truth over new modes, retries, background services, or option matrices." The mechanism is a learning dynamic in the *development process*: each field report is a single sample, the cheapest response is a new guard, and no force removes old ones. Result: bounded retry + retained steer + loud solo + blocked CompleteGoal + threshold skip coexisting with the pre-existing policies they patch, each with its own failure semantics.

- **Observed:** the fix list in fact 4; the constraint text; the field reports in facts 8–9.
- **Inferred:** that the fixes were driven by single incidents rather than a failure taxonomy; the brief doesn't say this explicitly.
- **Falsifiable prediction:** at least two of the added guards handle the *same* underlying event class (e.g., hello-retry exhaustion and loud solo fallback both encode "supervisor unresponsive"), so merging them would change no observable behavior in the test suite.
- **Cheapest discriminating check:** enumerate every place the code classifies a failure (hello retry, compaction failure, steer delivery failure, model error) and tabulate the classification used. If three or more distinct transient/permanent/cancelled schemes exist, M3 is supported. Pure code reading; cost: under an hour.

### M4 — Unintended runtime learning dynamic: supervisor narration as the only available action
Fact 8: supervisor "attempted to send an overnight instruction after the worker disconnected, generated repeated long status narration, and could not deliver." The retain-newest-steer fix bounds *what* gets replayed but not *why* the supervisor narrates: when its one channel is dead, the only action that satisfies "all supervisor thinking and messages should be visible" is to produce more visible text. The prompt rewards recaps; there is no cheap, sanctioned "no change, waiting" act. The fix treats the symptom (replay unboundedness), leaving the loop that generated the narration.

- **Observed:** fact 8 verbatim; "The new code keeps only the latest instruction and replays it after reconnect"; "an ended worker session still requires reload/restart to return."
- **Inferred (I3 above):** the narration is prompt-pressure-driven rather than a model quirk. Single field report; weak evidence.
- **Falsifiable prediction:** with the worker killed mid-plan, the supervisor still generates ≥N words of novel status per turn after the retained steer is queued, even though nothing actionable remains.
- **Cheapest discriminating check:** in the isolated UAT, complete a plan, kill the worker session, send one steer, and record supervisor output volume over the next K turns. Compare against a variant where the supervisor is told (one prompt line) that silence is acceptable while waiting. If volume doesn't drop, the prompt-pressure hypothesis is wrong; M4 shifts toward "model quirk," which changes which simplification is worth doing.

### M5 — Duplicated plan truth compensated by re-injection
The plan exists on disk, in worker state, in the supervisor's prompt, and in intercom messages; on resync "Startup and compaction repeat the longer role prompt and full active plan before appendices/history." Re-sending the full plan is a compensating control for not trusting any single store. "Complete signed-off plans remain paired" is another copy-consistency rule. This is a structural source of complexity: every state transition must keep N representations coherent.

- **Observed:** the AGENTS.md resync quote; worker code restoring "the complete plan once after session start or compaction"; sign-off/pairing rules (fact 3, 4).
- **Inferred:** that the supervisor could read the plan artifact from disk (it has tools; it's read-only-by-role) instead of receiving a serialized copy, without loss of its verification duty. Not yet tested.
- **Falsifiable prediction:** replacing full-plan re-injection with a pointer ("plan v3 at <path>, hash H") plus supervisor tool-read yields identical supervisor verification decisions on a scripted UAT with a deliberate mid-run compaction.
- **Cheapest discriminating check:** one UAT run where the resync message is shortened to role prompt + pointer; verify the supervisor still catches a planted worker deviation (e.g., artifact missing a required sign-off). If detection fails, the full-plan copy is load-bearing and M5's simplification is refuted cheaply.

### M6 — Contradictory timeout semantics across policies
Fact 9: "A timeout is not proof of a permanent failure." Yet hello retry is bounded (initial + two retries) and feeds a loud solo fallback, i.e., timeout eventually *is* treated as failure; meanwhile compaction timeout is treated as non-fatal and retryable via `/goals supervise`/`reconnect`. The system holds both "timeout ⇒ keep waiting" and "timeout ⇒ eventually go solo" depending on which subsystems' timeout it was, with no shared classification.

- **Observed:** fact 9's policy statement; bounded retry (fact 4); the two different recovery commands in `supervisor-session.ts` error paths.
- **Inferred:** that a rate-limit stall could, under the wrong sequence, trip hello-retry exhaustion and trigger loud solo even though the supervisor was merely slow — i.e., solo triggered by a transient. No observed instance; this is the mechanism's risk claim.
- **Falsifiable prediction:** injecting a provider stall of duration > hello-retry budget but < actual supervisor death causes the worker to announce solo fallback while the supervisor later recovers and resumes — two authorities active.
- **Cheapest discriminating check:** in the isolated Herdr scenario, wrap the supervisor's provider with an artificial delay (or use a slow model) so Ready arrives after the retry budget. Observe whether solo is announced and whether the supervisor's late Ready creates conflicting state. One scripted run; no new production code needed if the delay is done at the provider/proxy layer.

## 3. Simplification designs (architectural reductions; not ranked, no winner)

Each design lists what is **removed** and the discriminating check that would kill or support it. All are testable in the small isolated Herdr scenario.

- **D1 — Single compaction owner for the pair.** Remove the worker's pre-fork `compactApprovedWorker` *or* the supervisor's startup/skip logic, so exactly one side decides. Given the supervisor already skips on an inherited `compaction` entry, removing the supervisor startup trigger (letting the worker's pre-fork compaction + Pi auto-compaction suffice) is one direction; the converse (worker never compacts, supervisor decides after fork) is the other. *Removes:* one trigger site and one skip heuristic. *Killed by:* M1's logging check showing the removed site was the only effective compaction in some lifecycle (e.g., supervisor resumed with large non-compacted context).
- **D2 — Delete the numeric threshold; trust Pi's errors.** Remove the 100k gate and rely on attempting compaction and accepting `Already compacted`/`Nothing to compact`, or on Pi's default auto-compaction entirely. Premise: I2 (the observed error was cosmetic). *Removes:* a magic constant shared across two files. *Killed by:* evidence that the "Nothing to compact" error aborts or corrupts something downstream in any supported Pi version — checkable by re-running the pre-skip UAT configuration and confirming continuation, which fact 7 already suggests but doesn't prove for all paths.
- **D3 — Collapse failure handling into one classifier.** One function mapping any error/timeout to {transient, permanent, cancelled}, used by hello retry, compaction, steer delivery, and solo fallback. *Removes:* per-site retry/regex/fallback policies (M3, M6). *Killed by:* M3's code-reading tabulation showing the sites genuinely need different classifications (e.g., a compaction timeout is retryable but a model auth error is not — though a single classifier can encode that too; the check is whether the tabulated classes collapse).
- **D4 — Give the supervisor a sanctioned cheap "no-change" output, or delete the recap obligation.** Addresses M4 at its cause rather than bounding replay. *Removes:* prompt pressure to narrate; potentially the retained-steer replay queue if combined with "undeliverable steers fail loudly to the human" (constraint-compatible: "Do not ... pretend delivery/recovery succeeded"). *Killed by:* M4's kill-worker experiment showing narration persists even with the sanction — then the queue is the right lever and D4 is wrong.
- **D5 — Plan-by-pointer instead of plan-by-copy on resync.** *Removes:* "repeat the ... full active plan" payload on startup/compaction; shrinks supervisor token spend toward "doesn't use many tokens." *Killed by:* M5's planted-deviation check failing (supervisor misses a deviation it caught with the full copy).
- **D6 — Make ended-worker recovery a first-class small command instead of reload/restart folklore.** Fact 8 says recovery "requires reload/restart to return," which is a human memory procedure, not a mechanism. A single `/goals recover` that reloads the worker session and replays the retained steer replaces two implicit steps. Note this *adds* a command to *remove* a manual procedure — defensible under the constraints only if it deletes more than it adds. *Killed by:* showing `/goals reconnect` or existing commands already cover the ended-worker path, in which case the gap is documentation, not architecture.

## 4. Cheapest discriminating checks, ordered by cost

1. **Log-only compaction census** (M1, D1, D2): one log line per `ctx.compact` call; rerun existing UAT. Minutes.
2. **Failure-classification tabulation** (M3, D3): read-only code survey. Under an hour.
3. **Pre-skip UAT rerun** (I2, D2): confirm the "Nothing to compact" error is cosmetic across the whole flow, not just the observed continuation. One run of an already-built scenario.
4. **Kill-worker narration experiment** (M4, D4): one scripted run + one prompt-variant run.
5. **Planted-deviation pointer test** (M5, D5): one run with a doctored artifact.
6. **Provider-stall injection** (M6): needs a delay shim; the most expensive check listed, but decisive for whether loud solo can fire on a transient.

## 5. Observation vs. inference ledger

- **Observed:** brief facts 1–10; the four compaction call sites and benign-error regex in source; the UAT error message and its disappearance after the skip; the monotone-additive fix list.
- **Inferred:** I1 (accretion dynamic), I2 (error was cosmetic), I3 (prompt-pressure narration cause), and every risk claim in M2, M5, M6 that lacks a reproduced incident. None of these should be treated as established until its paired check runs.

No winner selected. The checks in §4 are designed so that each one, whatever its outcome, eliminates at least one mechanism or one simplification design cheaply.
