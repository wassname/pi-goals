# Review against user intent

## Follow-up: code fixes, full goal still unproven

Implemented directly after the subagent runner failed and the user authorized direct work. The tests now exercise full advice in real Pi tool components (collapsed, expanded, restored, streaming arguments), emitted thinking/text display, resume without replay of persisted views, latest-view coalescing, actual idle/busy status, stale-view approval rejection, and stopping completed-plan timers. The supervisor prompt now asks for a brief evidence-based progress assessment and useful judgment instead of instruction-only reviews. Background job status is explicitly unmeasured; approval still requires the supervisor to inspect job evidence when relevant.

[Saved validation output](20260908_supervision-fixes-validation.txt):

> Tests  34 passed (34)
> resumed: deliveredViews=0, activeTools=read, readyReceipt=true
> interval view without any work: The worker stopped.

Typecheck and lint also succeeded in that log. The reproduction script now asserts the corrected behavior; the original reproduction output below is retained as historical evidence. Readiness is cleared on startup and normal shutdown, but it is not a heartbeat or proof of worker receipt. The review here is my own source/diff review, not the independent review that failed to launch. Existing user panes and the separate pi-supervise worktree were not modified.

Remaining acceptance: a real isolated two-pane run with the intended model pair, observed useful advice and worker response, plus measured token/cost totals. Prompt assertions do not establish judgment quality. No full-goal completion is claimed.

-- Pi/OpenAI

## Original review

Verdict at `06794bf`: not achieved.

Reviewed `experiment/goals-owned-supervision` at `4ebb4d1` against [AGENTS.md](../../AGENTS.md#user-intent-for-this-branch). This is a source review and isolated runtime reproduction by Pi/OpenAI, not an independent model review or a real two-pane acceptance test. No existing session or pane was operated.

The overnight `goals-supervisor-01a040d0` transcript used the older pi-supervise/intercom implementation. It is not runtime evidence for this mailbox branch. The uncommitted display patch in `/tmp/pi-supervise-visible-advice` is also separate from this branch and was not counted as completed work.

## Findings

1. **P1: the supervisor's actual advice is still hidden by the default tool-call display.** `src/supervisor-session.ts:157-169` registers `SteerWorker` without a call renderer and returns only a receipt. This fails the user's explicit visibility requirement. Normal emitted assistant text/thinking uses Pi's own display; the local setting already has `hideThinkingBlock: false`. That does not reveal advice inside unrendered tool arguments.

   Observed in the isolated harness:
   > steer: renderCall=undefined, result=Worker instruction 1 recorded.

2. **P1: supervisor resume loses monitoring and read-only tool selection.** `src/supervisor-session.ts:94-107` returns when it finds the persisted bootstrap marker, before starting the new process's polling timer or removing write tools. `ready.json` remains present, so the receipt does not identify this loss of supervision. The harness starts, shuts down, then registers a new extension instance using the saved entries and default tools:

   > fresh: deliveredViews=1, activeTools=read, readyReceipt=true
   > resumed: deliveredViews=0, activeTools=read,write,bash, readyReceipt=true

   This reproduces a branch bug; it is not a diagnosis of the different overnight implementation.

3. **P1: periodic views can tell the supervisor an idle worker is running.** `src/index.ts:201-203` publishes an interval view without checking idle state. `src/worker-view.ts:45` derives worker status from the review trigger, not actual execution. This undermines decisions about whether continuation is needed.

   > interval view without any work: The worker is still working.

4. **The intended judgment and recap behavior is not established.** The current supervisor prompt (`src/supervisor-session.ts:70-73`) emphasizes:
   > Use SteerWorker to give one concrete instruction when work is incomplete.

   Most of the remaining prompt concerns approval checks. It does not request the user's short assessment of progress, independent perspective, or explanation of a recommendation. This is a mismatch in emphasis, not proof that Astra cannot exercise judgment. Neither minimal thinking nor the requirement to use a steer tool establishes a cause of poor advice.

5. **Low-cost, useful supervision remains untested.** `src/worker-view.ts:41-46` repeats the last compaction summary and up to 12,000 characters from recent messages; it does not make incremental views or measure usefulness/cost. The RPC test (`test/rpc-review.test.ts:51-52`) tests Refine/editor ordering with a deterministic model, not a cheaper worker benefiting from an expensive supervisor. Passing it cannot establish the intended economic or behavioral outcome.

## What is present

- Herdr two-pane launch with an explicit planning-session fork: `src/herdr.ts:49-86`.
- Separate supervisor model selection via `/goals model`; the worker keeps its model. The cheaper-worker/more-expensive-supervisor arrangement is possible but not established by default or validated on a task.
- Initial context compaction above 20k and subsequent compaction at 100k: `src/supervisor-session.ts:8-10,113-155`. This broadly meets the request for compaction around 150k or similar; the exact threshold is not the main gap.
- Direct canonical plan path in the supervisor prompt and worker resynchronization after compaction.
- Settle, 50-turn, and hourly review triggers. Reliable continuation is incomplete because of the resume/status defects above.

## Acceptance still needed

First make the advice visible and correct resume/status behavior. Then run one bounded task in separate test panes with the intended model pair. Save the rendered advice, worker receipt, a useful progress assessment or correction, continuation after compaction/resume, and measured token/cost totals. Judge the content of the advice, not the number of messages or merely successful delivery. Do not use the user's working panes for this test.

The transport rewrite is an implementation choice, not the user's goal.

## Reproduction

The mailbox reproduction script is historical; retrieve it at commit `386305a`. The Intercom migration removes that implementation. Current transport checks are in `test/intercom.test.ts` and `test/intercom-broker.test.ts`.

[Saved output](20260908_supervisor-intent-reproduction.txt) records the exact observations quoted above. The harness uses only temporary mailbox files and mocked Pi lifecycle events; it neither launches Pi nor contacts another session. It asserts the currently observed failure, not desired behavior.

-- Pi/OpenAI
