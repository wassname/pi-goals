# Supervisor prompt flow review

Pi/OpenAI implementation, based on `a7385d4`. Scope: centralize supervisor instructions in `src/prompts.ts` and make check-in tasks and tool descriptions ask for judgment followed by useful action. No transport, lifecycle, approval-gate, plan-selection, or planning-policy changes.

## Narrative order and wiring

1. Existing planning and worker resync prompts, unchanged.
2. `supervisorOpening`, `supervisorPrompt`, `supervisorReviewContext`, `supervisorOrientation`, `supervisorCompaction`: role and plan context. The user-authored agency opening and constitution/pi-supervisor provenance are retained. Long role asks for applicable AGENTS.md/skills, remains generic, removes one duplicate autonomy paragraph, and makes SteerWorker—not a recap—the continuation action. The short review and startup/compaction cadence are unchanged.
3. `supervisorCheckIn`: ready, started, active periodic, stopped/settled, plan-edit tasks. `src/worker-view.ts` invokes it outside truncatable activity content. Status prefixes remain exactly `The worker is ready to begin.`, `The worker is still working.`, and `The worker stopped.`. Observed idleness still governs the prefix; an idle interval gets stopped guidance, while a nominal settled event that is not idle gets active-work guidance.
4. `supervisorPlanReview`: existing diff/claim data plus plan-change guidance, wired from `src/index.ts`. The guidance now precedes truncatable diff detail so long diffs do not evict it.
5. SteerWorker description, parameter description and delivery result.
6. ApproveGoal description, parameter descriptions and approval-success instruction. Acceptance is conditional on the supervisor judging the result achieved; mechanics are a separate paragraph. Gate errors stay at their checks, unchanged. The successful result tells the supervisor to use SteerWorker for CompleteGoal and continue remaining goals.
7. Existing worker CompleteGoal description corrected to address its caller: the worker runs verification and seeks supervisor review first; the tool consumes recorded approval. It no longer tells the worker to "direct the worker" or implies the read-only supervisor can create evidence. Approval gates are unchanged.

Runtime data labels and view serialization remain near their producers, rather than turning this into a string registry. The dynamic mechanical errors remain in supervisor-session.ts as allowed by the task.

## Exact event tasks

Ready:
> Check the agreed outcome and decide the next useful action. Use SteerWorker to send the worker a concrete starting instruction; do not repeat one already being acted on.

Started:
> The worker has begun a turn. Check whether its direction fits the agreed goal; let productive work continue and use SteerWorker only if a correction is needed.

Active periodic:
> Is the worker on track toward the user's intended outcome? Check for drift, mistaken assumptions, or wasted effort. Use SteerWorker to send a correction where useful; otherwise let productive work continue without interruption.

Stopped/settled:
> Inspect the results and judge whether the agreed goal is actually achieved. If unfinished, investigate why the worker stopped and use SteerWorker to send the next useful instruction and resume work. If a verified dependency prevents progress, establish what will resume it and how that will be observed. Do not treat stopping as completion. Consider ApproveGoal only after the results satisfy the goal.

Plan edit/manual tick:
> Assess plan changes against the user's intent and preferences. Manual checkbox edits are claims, not proof of completion. Inspect the actual result before accepting a claim; use SteerWorker to send corrections when the plan or work has drifted. Preserve authorized changes.

ApproveGoal decision paragraph:
> Use only after judging that the actual result satisfies the user's intended outcome and the goal's discriminator. This tool records your acceptance; its mechanical checks cannot establish success. If the goal is unmet or evidence is insufficient, do not approve: use SteerWorker to request the next useful work or check.

## Validation and limits

- Read AGENTS.md, annoy-less skill and installed Pi extension docs: before_agent_start persistent custom messages/chained system prompt, and sendUserMessage behavior (an idle worker starts a turn; an active worker receives queued steering).
- `validation.txt`: 108 tests pass in 19 files, including real installed Pi RPC and native fork/Intercom checks; typecheck, lint, build and diff check pass.
- `initial-validation.txt`: same tests/typecheck passed, lint found only two import-order issues. Fixed those and reran the full command successfully.
- Added 9 worker-view event/status combinations and 3 prompt-semantic tests. Updated flow tests assert manual ticks and external plan edits carry judgment/continuation instructions. Supervisor hook/tool tests verify centralized text is wired, including startup/compaction and approval success.
- Native pair fixture now produces its view through the actual workerView. The real Pi provider request is asserted to contain the stopped task and actual registered SteerWorker/ApproveGoal descriptions, and its emitted instruction reaches the worker exactly. The local model is deterministic: this establishes wiring, not judgment quality.
- Approval logic/transport/plan extraction are unchanged. `git diff --quiet HEAD -- src/approval.ts src/intercom.ts src/plan-view.ts src/plan.ts` passed before commit. Unicode envelope budget regression still passes with the added event tasks.
- No user or test Herdr panes operated. No push. Unrelated dirty native logs were not changed; docs/human_journal.md was never read or written. Tests unset inherited PI_GOALS_EVIDENCE_DIR, PI_SUBAGENT_CHILD and PI_GOALS_ROLE.

## Parent acceptance still required

In a new isolated Herdr task, require an exact result (for example a specific byte sequence). Let the worker stop with a real artifact that fails that goal. Read both panes and the artifact: the supervisor must identify the mismatch, send a corrective SteerWorker instruction rather than approve, observe the resumed worker, and only approve after the corrected result satisfies the discriminator. Also confirm productive active work is left alone and an authorized plan edit is not mechanically rejected. Do not count deterministic test output or delivery receipts as autonomous outcome success. Independent reviewer gate remains parent-owned.
