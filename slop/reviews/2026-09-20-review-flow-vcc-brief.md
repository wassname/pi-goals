# Review brief: supervisor stop decisions and worker VCC view

## Question

Does the uncommitted implementation preserve the intended supervisor workflow and produce a useful compact worker view without hiding state needed for judgment? Find correctness, lifecycle, persistence, identity, and information-loss bugs. Review only; do not edit files.

## User intent

> “if a worker tried to stop or change the plan it can 1) steer 2) allow an edit to plan (as long as worker didn't stop) 3) full review see if it should stop. So the paper work is only for the end (or potential end).”

> “the whole point is to not dump the transcript or json”

> “The worker view should be compact VCC Markdown: summarize current process/subagent presence; do not dump transcripts, raw JSON or repeated compaction, and request detail only when needed.”

The supervisor, not the worker event kind, chooses whether formal review is warranted. A recoverable failure should normally get a direct Intercom steer. Acceptance of a formal stop review does not complete a plan goal; `CompleteGoal` remains separate.

## Changed behavior

Review flow:

- Every incoming worker event is first saved as `pi-goals-worker-event`.
- `review_request`, `blocker`, `completion`, `aborted`, and `unclassified` wake the supervisor but create no formal report.
- `review_subagent(eventId=...)` accepts only those potential-stop events (or an already selected legacy report). After evidence validation it writes `pi-goals-report`, then sends the review. A delivery failure leaves that explicitly selected review pending.
- `decision`, progress, waits, receipts, and in-flight plan edits require no review form.

Worker view:

- `worker_view` now returns incremental VCC Markdown rather than raw paired tool-call/result dumps.
- Intercom supplies connection status, model, context use, and worker PID.
- A `ps` snapshot summarizes recursive child processes and exact `pi` children.
- VCC keeps compact one-line tool calls and omits raw tool-result bodies.
- Native compaction summaries are not printed.
- `detail: "diagnostic"` adds bounded IDs/process commands, still without raw results.
- A cursor in pi-goals state records turns already shown.

Blank-message fix included in the same working tree:

- role-changing prompts render as a compact nonempty normal user message;
- passive status messages use one visible custom message;
- exact model input remains saved.

## Evidence and scope

Read complete relevant files, not only this summary:

- `AGENTS.md`
- `src/index.ts`
- `src/prompts.ts`
- `src/worker-view.ts`
- `src/notice-display.ts`
- `test/goals.test.ts`
- `test/notice-display.test.ts`
- `test/rpc-review.test.ts`
- `git diff -- AGENTS.md README.md src test`

Ignore unrelated uncommitted `RESEARCH_JOURNAL.md` and `docs/human_journal.md`.

Current local checks: 136 tests passed; typecheck and lint passed before this review brief was written.

Please prioritize subtle failures over style. In particular, reconstruct whether event deduplication, offline delivery retry, reload, cursor persistence, stale worker identity, missing tool results, process-tree limits, and compact prompt restoration behave as claimed. Distinguish implementation correctness from whether the view is empirically useful.

— PI/OpenAI
