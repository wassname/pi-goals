# Supervision intent review

Scope: current `README.md`, `AGENTS.md`, `src/prompts.ts`, `src/index.ts`, `src/worker-view.ts`, tests, and read-only tails from four active supervisor sessions. The live sample is selected, small, and partly stale. It shows possible failures, not their frequency.

## Judgment

Current source is substantially closer to the user intent than the active-session tails. The central remaining rollout problem is that live supervisors keep the extension and scheduled prompt they loaded earlier. The clearest current-source defect was a duplicate automatic stop after explicit `running` or `waiting`; it is fixed in this change.

The design cannot guarantee research judgment through prompts. The BS-bench tail is direct evidence that a capable supervisor can still accept a worker's invented experimental criterion. The new supervisor-role instruction addresses the right layer: the supervisor must personally interpret the experiment rather than treating implementation review as the scientific decision.

## Findings

### 1. A supervisor accepted an invented experimental stopping rule

Production observation, Steering-lite BS-bench:

> “The implementation incorrectly invented two blocking thresholds: `1:4 score > 0`; `max off-axis ≤ 2.5`.”

The supervisor had declared the initial study complete before the user pointed out that there was no threshold and the requested Modal evaluation had not run. This violated the README's central premise that the stronger supervisor adds judgment and protects the goal.

Current-source response:

- `src/prompts.ts` now says the supervisor personally performs high-level diagnosis, research interpretation, experimental design and consequential judgment.
- It says workers provide bounded execution, evidence gathering and independent criticism.
- The supervisor role now directly forbids inventing pass/fail thresholds or turning a ranking metric, soft preference or example into a stopping criterion unless the user or approved plan made it a requirement.
- `AGENTS.md` records the same division of responsibility as user intent.

These are prompt-level mitigations. They are not evidence that future supervisors will comply.

### 2. Explicit running/waiting generated a duplicate potential-stop event

Code observation before this change:

- `ReportGoalEvent(running|waiting)` saved a non-reviewable `WORKER_EVENT`.
- `agent_end` then called automatic `reportStop(..., unclassified)`.
- automatic suppression checked only prior `STOP` records.
- the resulting `unclassified` event woke the parent as a potential stop.

The LUCID tail showed this exact sequence. The quick-oracle reviewer independently found the same path.

Fixed in this change: automatic agent-end reporting now reuses explicit `running`, `waiting`, `no_change`, or `decision` events from that run. A truly silent turn end still emits `unclassified`. A `receipt` or plain `progress` still allows the automatic stop wake: attachment receipts need the parent to assign work, and progress alone does not establish a followed job.

Kimi found that applying the same suppression to graceful shutdown would hide termination and alter disconnect classification. The implementation now suppresses only routine `agent_end`; `session_shutdown` still records and publishes the shutdown. Regression coverage checks intentional waiting, a later silent stop, deliberate progress that still needs a parent wake, and graceful shutdown after waiting.

An ungraceful disconnect after `running` or `waiting` now wakes the parent as a blocker because no shutdown record exists. This is intentional: the followed job may continue, but its worker/follower coverage is unknown and the supervisor must restore coverage rather than treat the disconnect as a passive receipt.

### 3. Active sessions are not evidence of the current renderer or prompts

The LUCID and BS-bench tails still show the old worker view:

> `### Recent calls and results`

with argument/result blocks. Current `src/worker-view.ts` and tests explicitly omit that section, raw result bodies, JSON and compaction dumps. These panes had not successfully loaded the current extension.

The manifold scheduled wake also contains an older instruction:

> “reserve formal review for completion, bounded artifact approval or a genuine accepted blocker”

Current source instead says formal review is used only when the supervisor may allow the worker to stop. Reloading updates the system role, but pi-goals deliberately preserves an existing schedule's custom prompt bytes. Therefore an old owned check-in can continue injecting old wording after reload. This rollout mismatch remains unresolved; custom human prompts must not be overwritten blindly.

### 4. Formal-review policy in current source matches the three-choice intent

Current supervisor instructions say:

1. steer or retry in the same session;
2. permit an in-flight plan edit while work remains open;
3. use `review_subagent` only because the supervisor may allow the worker to stop.

Only the third choice creates formal review state. The scheduled default and worker-event text repeat this rule. The manifold review churn is evidence about an older loaded prompt or model noncompliance, not the current intended flow.

### 5. Task and evidence edits no longer create supervisor turns

Production observation before this change:

> “plan changed” → “checkbox update applied” → “No change.”

`planViews` now separates the full pre-Log activity view from the material notification view. Task checkboxes and evidence paths change the activity hash and create one collapsed passive record for the next ordinary turn; they do not wake the model. Goal checkbox status, requirements, discriminators, scope and preferred worker model still change the notification hash and wake the supervisor. Tests distinguish evidence/subtask edits from goal-status and requirement changes.

### 6. Credential display restrictions were mistaken for execution restrictions

Production observation, manifold-steer:

> “Blocked before queue submission: harness denies `--env-file .env`.”

The supervisor then asked the human to run an otherwise authorized judge command, even though the project could load the credential without displaying it. The user clarified that `python-dotenv` or shell-sourcing `.env` exists for this purpose. Shared worker/supervisor guidance now distinguishes displaying secret bytes from running an authorized credential-backed command. It requires the existing project loader, forbids reading, printing or sending secret values, and asks the human only when authorization, the credential or execution permission is actually absent.

### 7. Check-in behavior is mixed but often follows intent

Observed good behavior:

- meatybroth's supervisor independently profiled the central query and found an 82 s versus 2.1 s formulation difference;
- its `/busy` response tied the diagnosis to the user-visible goal;
- manifold slowed its check-in from one to two and then three hours for a followed long job;
- LUCID, after direct user correction, personally inspected the learning curve and recurrence assumptions, then delegated only a specified diagnostic implementation.

Observed failure:

- that LUCID role division happened after the user intervened, not before;
- manifold still produced many intermediate acceptance messages;
- the BS-bench supervisor confused implementation terminal logic with the requested scientific experiment.

The evidence supports “partly working, still needing the stronger role instruction,” not “working as intended.”

## Independent review

Quick-oracle run `d4aa5dac-c8fa-4a44-9893-be2837831b2d` confirmed the duplicate running/waiting lifecycle bug and confirmed that current formal-review and worker-view prompts otherwise match the stated intent.

The OpenRouter Kimi reviewer read the source and reproduced tests with `PI_SUBAGENT_CHILD` removed. Its first run timed out before a verdict; a bounded continuation produced the saved review `kimi-supervision-review.md`. It confirmed the lifecycle bug, identified the graceful-shutdown regression in the first fix, and noted that the invented-threshold failure needed a direct supervisor instruction. Both points were fixed and covered above. Its final re-review confirmed the fixes. The remaining disconnect wake and progress/receipt boundary are deliberate and now documented/tested.

Kimi also raised uncertainty about custom-triggered turns bypassing `before_agent_start`. Pi's runtime source shows that ordinary prompt preparation stores the modified supervisor system prompt in `agent.state.systemPrompt`; custom follow-ups reuse that state. pi-goals forces a normal user prompt whenever the role is not prepared, including after reload. The central supervisor role therefore remains present on same-role worker-status follow-ups.

## Verification

- `npm test`: 141 passed.
- `npm run typecheck`: passed.
- `npm run lint`: passed.
- scoped `git diff --check` for changed pi-goals files: passed.
- repository-wide `git diff --check` still reports pre-existing trailing whitespace in modified `docs/human_journal.md`; that human file was not edited.

— PI/OpenAI
