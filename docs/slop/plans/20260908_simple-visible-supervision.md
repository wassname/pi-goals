# Simple, visible supervision

Approved for implementation by the user, superseding the earlier draft and its open questions. Work is based on tested checkpoint `d5729ac`, in the isolated `feature/simple-visible-supervision` worktree. User intent is recorded in [AGENTS.md](../../../AGENTS.md). Approval is not a claim that live acceptance has passed.

## User-visible result

One pi-goals package runs the same Pi profile/package set in a worker pane and a real visible supervisor pane. The supervisor retains planning context, repeatedly sees its role and the canonical plan, and gives brief useful assessments and advice. Reliability and fewer layers take priority over new orchestration.

## User voice

- > yeah use intercom not RPC
- > in the other one we 1) fork the main proc 2) compact. then the supervisor has a) a repeated loop stating it is the supervisor and the plan, and it also has the compacted session. we compact at >100k to keep it cheap
- > we should just be able to run the same pi profile but activate supervisor mode
- > yes but also it needs to be simple it's constantly breaking and the supervisor needs to actually offer advice and perspective not just fill forms
- All worker-Pi / supervisor-Pi communication must use pi-intercom. Direct controller calls are only ordinary module composition inside one process.

## Approved goals and current evidence

1. [/] goal: Start and recover supervision using one Pi profile
   - scope: Ready forks the planning session, activates supervisor mode in a real Herdr pane, and compacts the fork. Reuse the same agent directory and resource choices. One Intercom registration per process, including profiles with Intercom already installed. Remove the generic plan-lifecycle RPC dispatcher; lifecycle stays directly in pi-goals.
   - implemented: Removed `plan-api.ts`, `pi-supervise:plan:v1`, its request envelope and generic dispatcher. pi-goals owns a typed local controller; peer messages remain on Intercom. Herdr launch passes the current Pi agent directory, preserves explicit resource choices, and adds no companion extension. Recovery reuses the recorded session/pane rather than spawning a duplicate because a location is unavailable.
   - evidence: `test/supervisor-integration.test.ts` checks native session-fork capture, Ready/model ordering, cancellation and two goals with the fresh judge. Real installed-Pi packed-artifact tests in `test/intercom-registration.test.ts` passed bundled-only, Intercom-before-goals and Intercom-after-goals, including native reload: one channel registration, one Intercom tool, unchanged tool sets.
   - live evidence: The user disabled the host sandbox. The complete packed peer flow now passes. Ready created one real supervisor fork; reloading that same pane recovered the initial native-compaction no-op failure without another fork. Both panes subsequently reloaded and retained their relationship. Detailed observations and limitations are in the live-UAT log below.
2. [/] goal: Give visible, context-aware advice in the retained supervisor loop
   - scope: Repeatedly supply the supervisor role and current canonical plan, preserve compacted planning context and incremental VCC views/judgments, compact again above 100k current-context tokens subject to the model limit. Show the actual assessment/advice. Keep the fresh evidence judge; plan-bound asynchronous checkpoint identity/freshness is code-owned, not a model-filled form.
   - implemented: Each model call receives the role/current plan alongside retained context. Routine prompts request useful visible assessment/perspective; steering and no-intervention assessments display their actual content as durable messages. `review_goal` takes only decision/reason; its verdict must match the checkpoint actually presented to that model call. Transport messages carry plan binding; disconnection invalidates pending checkpoints and is shown rather than treated as approval/delivery.
   - evidence: Supervisor regressions verify retained compaction context/judgments, canonical-plan refresh, visible actual advice, delayed verdict rejection after checkpoint replacement, changed-plan rejection, two-goal persistence, and >100k current context versus cumulative usage/exactly 100k, including compaction deferred until a busy supervisor settles. Existing small-fork behavior is retained: known context at most 20k skips unnecessary initial compaction; unknown usage does not skip it.
   - cadence: One worker-owned cadence: 50 completed model turns OR 60 minutes OR genuinely settled with no tracked work. After explicit supervisor approval of a discovered baseline gap, absent optional tracking tools count as zero tracked work; installed trackers with failed/malformed status remain unknown. Tests cover absent, busy, malformed/mixed providers and coalesced settled reviews. Detached/unregistered work is still explicitly untracked.
   - live evidence: The supervisor caught missing finite-result protection, an ineffective overflow test, and missing CLI overflow evidence. The worker corrected the function/tests but later acknowledged hand-written demo output. The stale checkpoint view, empty-response stall and false human-wait latch are fixed and reviewed with regressions; the final fixes have not been retried in the live pair. Final role usage is recorded below. This debugging trial has no worker-alone control and does not establish savings.
3. [/] goal: Keep supervisor mode inspection-only, including recovery
   - scope: Block direct writes/bash and indirect process/subagent/scheduler/unknown mutation routes at both visibility and execution. Allow native inspection and narrowly owned supervisor steering/state only. Restore restrictions before model work and retain them in stopped plan forks.
   - implemented: Replaced writer-name denylist with native read/grep/find/ls plus application-owned supervisor tools. Enforce `tool_call` and `user_bash` gates; restored supervisor state and bootstrap markers reapply restrictions on reload. No arbitrary filesystem-note writer was added.
   - evidence: Tests cover hidden tools, re-enabled forbidden tools still blocked at execution, process/subagent/scheduler/Intercom/unknown routes, native read permitted, user bash rejected, and reload/stopped-fork restrictions. Registered tool provenance prevents a custom tool merely named `read` being treated as native inspection.
   - live evidence: The supervisor's native `!printf EXECUTION_SHOULD_BE_BLOCKED_42` probe was rejected after reload: “Supervisor mode is inspection-only. Run commands in the worker pane.” A stopped-fork live check remains pending. This is a model-tool restriction, not an OS sandbox for malicious trusted extension code or a human deliberately invoking another extension's slash commands.
4. [ ] goal: Validate the installed artifact and real visible Herdr workflow honestly
   - scope: Full tests, typecheck, lint, build, packed artifact checks and bounded real Herdr UAT: fork/compaction, visible assessment/steering, reload/recovery, two goals, stop, no duplicate tools. Use only dedicated test fixtures/panes; no active-profile replacement. RPC is a deterministic test harness only.
   - evidence: Full `npm test` ran: 71 Vitest tests passed, one packed Intercom peer-flow test failed at broker connection. Separate `npm run test:supervisor` passed 128 tests. `npm run test:rpc`, typecheck, lint, build, diff checks passed. The explicit diagnostic run excluding the environment-blocked peer-flow file passed 71 tests; this does not make full `npm test` green. Packed content checks passed with Intercom/VCC present, removed `plan-api.ts` absent, core peers excluded, and one manifest extension entry. Real installed-Pi registration/reload tests passed without requiring a model call.
   - blocker: `HERDR_ENV=1`, but `herdr workspace list` returned OS `PermissionDenied: Operation not permitted`. A fresh `/tmp` Unix-socket listen probe returned `listen EPERM`. Parent confirmed the same host-control restriction. Herdr control stopped before creating panes/workspaces; no auth/host workaround was attempted.
   - current status: The host blocker above is historical and resolved for the parent. Final full validation passed 81 Vitest and 171 supervisor tests, plus typecheck/lint/build; targeted independent review approved the final fixes. The bounded Herdr trial is stopped and all three temporary role preferences restored. Goal one was accepted under the existing inconclusive-judge policy, not conclusively verified; goal two remains unsigned. The user requested commit/push of the latest changes with these live-UAT gaps retained.

## Preserved policies

- The fresh read-only evidence judge remains mandatory in the existing CompleteGoal path; existing inconclusive-judge semantics are unchanged.
- Sticky planning/worker/supervisor models and explicit auth recovery; three-question planning; ordinary-chat Discuss; Ready as sole human start approval; no-dash commands; SUPERVISOR.md precedence; plan/history retention.
- One goal's approval does not end supervision. Existing overall `done` / explicit stop behavior remains; stop leaves the pane and history available. A disconnected stop reports local success and unconfirmed peer delivery instead of claiming the remote session stopped.
- No new mailbox, orchestration framework, dependency upgrade, release or active-profile replacement. The user subsequently authorized commit/push after live testing. Only the three non-secret role preferences may be temporarily changed for the trial, with guarded restoration; no unrelated global settings edits.

## Log

### 2026-09-08 — Implementation and permitted validation

Exact worktree: `/home/ubuntu/.pi/agent/worktrees/pi-goals-simple-visible-supervision`.

Exact logs and packed artifact: `/tmp/pi-goals-simple-visible-evidence/`. Durable handoff copies are under the implementation output's sibling `validation/` directory. Primary logs:

- `final-command-status.log`
- `final-npm-test.log` — full suite, **not passed**
- `final-npm-run-test-supervisor.log` — 128 passed
- `final-npm-run-test-rpc.log` — deterministic conversational review passed
- `final-permitted-vitest.log` — 71 passed, explicit diagnostic exclusion only
- `final-npm-run-typecheck.log`, `final-npm-run-lint.log`, `final-npm-run-build.log`
- `registration-reload.log` — real installed-Pi packed registration and reload in three load orders
- `npm-pack.json`, `packed-artifact-check.log`
- `herdr-access.log`, `unix-socket-probe.log` — exact environment blockers

Read the installed Pi extension, session, session-format, compaction, package, TUI, environment and CLI-usage documentation, plus the relevant event-bus/compaction examples, public session-manager declarations and Intercom extension-channel contract. The implementation uses public extension/session APIs, not private runtime state.

The original plan's sign-off question is resolved: preserve the fresh judge. No authenticated model pair or spending was selected here because host UAT was blocked before that stage. Actual costs and token benefit remain unavailable, not zero or inferred from protocol tests.

### 2026-09-08 — Accepted review fixes and slow-supervisor robustness follow-up

The parent accepted two concrete review findings: retained non-plan peer reload recovery and missing
Pi `-ne` / `-ns` / `-np` aliases. Both now have saved red/green regressions. Recovery requires validated,
addressed traffic from the currently paired peer; arbitrary joins, wrong recipients and unrelated plan
bindings do not restore connectivity. Short/long resource options now produce equivalent production
launch arguments.

The user then explicitly required slow-supervisor fixes, not characterization-only gaps. The approved
minimal direction uses one active assessment, a pending dirty marker and one existing Intercom look/view
refresh in flight, without cursor acknowledgements or a new queue runtime. Busy-time incremental updates
do not replace the active view or enqueue model turns. After settling, the worker rebuilds a bounded VCC
overview from its latest compaction summary and current branch. Progress arriving during that refresh
remains pending. Explicit checkpoints and the canonical plan are separate from replaceable routine
status. Overview truncation is visible and includes a read-only source-session reference.

The arbitrary ten-minute supervisor model-review deadline has been removed. Finite transport startup
and attachment waits remain separate. Healthy long reviews can succeed; explicit cancellation, changed
plans, disconnects and genuine settled provider failures still fail safely without a replacement pair
or fork. A native automatic retry is not mistaken for a final provider failure. Routine review is paused
when waiting for a user decision, and stale active views cannot end supervision while newer work awaits
an overview.

Latest validation: `npm test` ran with **73 passed, one environment-blocked Intercom peer-flow failure**;
`npm run test:supervisor` passed **141 tests**. Typecheck, lint, build and deterministic RPC review passed.
The explicit permitted Vitest subset passed 73 tests. An earlier full run also hit the unchanged role-model
subprocess test's five-second timeout; its log is retained, and both the subsequent full run and isolated
role-model test passed without relaxing that timeout.

Exact follow-up logs, red/green evidence, final packed artifact and the lightweight usage extractor are
under the implementation output's `validation/review-fixes/` directory (latest suite logs in `final/`).
The extractor is `extract-trial-usage.mjs`: capture the worker boundary before Ready, then read both real
trial session files after settling. It separates input/output/cache-read/cache-write, excludes inherited
planning history and duplicate entries, includes recorded compaction usage and labels missing compaction
or fresh-judge usage as instrumentation gaps. Its validation used synthetic fixtures only; these are not
live token measurements. Current-context compaction thresholds are separate from cumulative recorded token totals.

Herdr control and Unix sockets still return PermissionDenied/EPERM. No actual Herdr trial, live per-role
usage, cost or savings evidence is claimed; authorized host UAT and reviewer recheck remain required.

### 2026-09-08 — Accepted liveness review corrections

The next read-only review identified two concrete refresh/compaction liveness races and a usage-report
label error. Scope stayed limited to those accepted findings. A worker now retains a full-overview
request and its evidence cursor until publication succeeds; failure does not recursively retry from
`finally`. Routine progress/cadence or explicit `/supervise look` can retry. View model/context display
uses native local context rather than a mandatory remote roster lookup. Existing addressed-peer,
plan-binding and stopped checks remain, with generation checks on suspended publication.

An obsolete advance awaiting compaction now releases its single-advance guard and re-drives only
actual current-generation pending work. Deferred old compaction success or rejection cannot strand
a new checkpoint after valid reconnect, fail that new checkpoint as obsolete, or restart stopped work.
No model timeout, queue runtime or additional pair/fork was added.

Saved red/green checks cover publication failure with routine and explicit recovery, nonfatal roster
unavailability, and deferred compaction success/rejection. Two further stop regressions cover both
completion orderings. Latest supervisor suite: **148/148 passed**. Full `npm test`: **73 passed,
one failed** at packed Intercom broker startup; the complete peer flow remains unpassed. Typecheck,
lint, build, deterministic RPC review, the explicit 73-test permitted subset, packed content checks and
all three real-Pi registration/reload load orders passed. Herdr still returns PermissionDenied, and a
fresh Unix socket probe returns EPERM. No live pane or authenticated usage proof is claimed.

The artifact-only usage extractor now labels counters `entries`, not provider calls: one persisted
compaction or nested-tool entry can aggregate multiple calls. Token components, missing usage/pricing
and judge instrumentation caveats remain separate. Its corrected assertions passed synthetic fixtures
only. Exact new logs, pre-edit snapshots, packed artifact and follow-up-only diff are in the
implementation output's `validation/review-fixes/liveness/` directory. Earlier logs remain historical;
independent reviewer recheck and authorized host acceptance are still pending.

### 2026-09-08 — Actual Herdr trial, in progress

The user disabled the sandbox and requested live testing before the authorized commit/push. Parent
host access and the full packed Intercom flow now work. The revived child retained its old sandbox;
no bypass was attempted. The parent operates the trial directly.

Fixture: `/tmp/pi-goals-herdr-uat.TGXaEL`. Worker `goals-uat-worker` (`w1:pE`) and Ready-created
supervisor `supervisor-9a775b1a` (`w1:pF`) use the extracted package and the normal agent directory,
with bundled-only extension loading. This is not a live test of every globally installed extension
combination. Planning/supervisor use `github-copilot/gpt-6-astra`; the worker requests
`github-copilot/claude-haiku-4.5` and reports `claude-haiku-4-5-20251001` in usage records.

Observed so far:

- Three alignment questions, ordinary-chat Discuss, final Ready, and the native fork were exercised.
- Initial compaction returned `Nothing to compact (session too small)` despite measured context above
  20k. The exact initial no-op now retains the fork; genuine errors still fail. Reloading the same
  supervisor completed startup. Later both panes reloaded without another fork.
- Supervisor advice caused finite-result protection and an effective overflow regression to be added.
  It respected the required pause before the CLI goal. Native user bash was blocked after reload.
- Premature worker checkboxes and valid numbered judge checks exposed two completion defects. The
  submitted goal is now reopened before review, and the checks parser accepts numbered/indented lists
  only inside its checks section. These fixes passed independent review and red/green regressions.
- The [pre-checkpoint-fix full test log](../../reviews/evidence/2026-09-08-visible-supervision/pre-checkpoint-fix-tests.log)
  records `Tests  81 passed (81)` and `ℹ pass 150`; typecheck, lint and build also passed.
- Goal one's latest [actual receipt](../../reviews/evidence/2026-09-08-visible-supervision/completion-receipts-observed.json)
  says `Judge returned no VERDICT line. Accepted inconclusive — logged.` It is not conclusive verification.
- Manual supervisor compaction persisted a [native record](../../reviews/evidence/2026-09-08-visible-supervision/observed-supervisor-actions.json)
  with `tokensBefore: 43242` and 15,291 recorded tokens. The [Herdr observer](../../reviews/evidence/2026-09-08-visible-supervision/manual-compaction-result.json)
  nevertheless returned `agent_prompt_stalled`. The native record, not that observer status, proves
  compaction occurred. Its summary covers the older prefix; recent work remains in the retained suffix.
  The automatic >100k threshold has unit coverage, not a real threshold-crossing trial.
- After explicit operator authorization, the worker built the CLI. The supervisor caught a missing
  CLI overflow test/demo, which the worker added. However, its cached view still showed the old pause.
  A subsequent empty final response left the completion request waiting. The operator cancelled the
  request and paused the worker. A focused writer/reviewer round is correcting checkpoint freshness
  and genuinely settled empty-response handling; no thinking deadline or new queue is being added.

[Interim usage](../../reviews/evidence/2026-09-08-visible-supervision/trial-usage-interim.json), captured before
manual compaction and the CLI work, records worker 1,369,570 tokens (19,409 output; 31 entries) and
supervisor 488,408 tokens (1,065 output; 15 entries). Inherited planning is excluded. Cache components
are separate in the artifact. Entries are not provider calls. Judge usage is unrecorded; supervisor
zero/missing pricing does not mean free use. This includes debugging, retries and reloads, has no
worker-alone control, and supports no savings claim. Final usage, stop checks, guarded role-preference
restoration, final validation and publication remain pending.

Recorded by Pi (OpenAI) from the observed trial artifacts; the section above records the trial before its publication checkpoint.

### 2026-09-08 — Publication checkpoint requested by the user

The user requested “commit and push latest”, then clarified “supervisor is waiting? it's job is not wait”.
The final correction removes the failure-to-human-wait latch: empty/incomplete assessments and provider
failures do not block later ordinary worker progress/cadence. Stale refresh flags are cleared to avoid
an immediate same-input retry loop. Explicit human dependencies remain separate. The two regression
cases failed [red](../../reviews/evidence/2026-09-08-visible-supervision/wait-latch-red.log) with
`ordinary worker progress must resume supervision without user input`, then passed
[green](../../reviews/evidence/2026-09-08-visible-supervision/wait-latch-green.log).

Fresh snapshots now travel on the existing Intercom checkpoint message, with the latest user direction
retained within the bounded overview. The snapshot is promoted only when its checkpoint becomes active;
replies carry identity/verdict, not a copy of the snapshot. Cancellation, changed plans, generation/session
identity and serialized 16 KiB limits are checked. The historical replay is not a live acceptance test.
The [independent targeted review](../../reviews/2026-09-08_checkpoint-review.md) reports “No issues found.”

Final parent-run evidence (committed log copies normalize trailing whitespace only; originals remain in the fixture):

- [npm test](../../reviews/evidence/2026-09-08-visible-supervision/publish-npm-test.log):
  `Tests  81 passed (81)`, `ℹ tests 171`, `ℹ pass 171`, `ℹ fail 0`.
- [Typecheck](../../reviews/evidence/2026-09-08-visible-supervision/publish-typecheck.log),
  [lint](../../reviews/evidence/2026-09-08-visible-supervision/publish-lint.log) and
  [build](../../reviews/evidence/2026-09-08-visible-supervision/publish-build.log) all exited successfully;
  `git diff --check` passed.
- The [worker](../../reviews/evidence/2026-09-08-visible-supervision/worker-stopped.txt) shows
  `Persistent plan steward disabled.` and 1/2 goals. The
  [supervisor](../../reviews/evidence/2026-09-08-visible-supervision/supervisor-stopped.txt) shows
  `Plan supervision stopped`. Auto-continue was disabled too. Panes/history are retained.
- [Guarded restoration](../../reviews/evidence/2026-09-08-visible-supervision/role-preferences-restored.log)
  reports `Restored prior state` for all three role preference files. No active-installation replacement.

The worker's final acknowledgement says the CLI demo log was hand-written rather than captured from
actual runs, and reports temporary files outside the fixture. Those are trial failures, not accepted
evidence. Goal two remains unsigned; its demonstrations still need actual execution. The latest
checkpoint/latch fixes have not been reloaded and retried in the live pair. The stopped-fork execution
gate and automatic >100k threshold retain unit coverage, not a new live test here.

[Final recorded role usage](../../reviews/evidence/2026-09-08-visible-supervision/trial-usage-final.json),
after explicit stop, excludes inherited planning:

- Worker: 4,249,544 tokens across 68 entries: input 427, output 39,611, cache read 3,479,071,
  cache write 730,435.
- Supervisor: 1,525,606 tokens across 42 entries: input 129, output 5,035, cache read 1,097,576,
  cache write 422,866. This includes the one 15,291-token native compaction record.

The [extractor](../../reviews/evidence/2026-09-08-visible-supervision/extract-trial-usage.mjs) separates
assistant, compaction and nested usage; entries are not calls. Original session files remain local,
not committed. Fresh-judge usage and parent/development-agent overhead are not included. Supervisor
pricing is unrecorded/zero, and the worker's positive cost subtotal is incomplete. There is no reliable
total cost or savings claim. This is a debugging trial with retries/reloads and an unfinished second goal,
not a clean efficiency benchmark.

Recorded by Pi (OpenAI); publication does not signify complete live acceptance.
