# Review: package-based supervision prototype (uncommitted diff on `experiment/main-supervisor-edxeth` @ cb35fbf)

Scope: full uncommitted diff (src/prototype.ts, src/prompts.ts, tests, AGENTS.md, prototype/README.md), read whole files plus src/plan.ts, src/plan-view.ts, src/index.ts, src/supervisor-session.ts; installed scheduler (`pi-schedule-prompt/src/tool.ts`, `scheduler.ts`, `settings.ts`, `types.ts`) and `pi-intercom/index.ts` read for verification; AGENTS.md, plan `slop/plans/20260910_package-based-supervision.md`, UAT `slop/reviews/20260910_package-supervision-herdr.md` and captures checked. Read-only review; no edits, panes, messages or installs.

Prior author claims re-verified against source, not repeated: the earlier "parent source findings" list is mostly fixed in this diff — `PI_GOALS_SHARED_PLAN` is gone (AttachGoalPlan, prototype.ts:457-467), `attach solo` routes through `confirmSolo` with generation/workerRevision re-checks (prototype.ts:196-205, 352), signoff-invalidating `refresh` moved inside the debounce (prototype.ts:155-160), and the eight-turn upkeep reminder is ported and tested (prototype.ts:211-226; test/prototype.test.ts:416). The findings below are what remains.

## Findings

### 1. HIGH — scheduleCheckIn demands session-binding verification the schedule_prompt output cannot provide
`src/prompts.ts:328-329` (`scheduleCheckIn`): "add one session-bound interval '1h' job ... Verify the returned session is `<id>`; if the new job is unbound, remove that new job and report the scope error."
Installed `pi-schedule-prompt/src/tool.ts:111-125` (add result) prints only name/id/type/schedule/prompt/model line; `list` (tool.ts:300-325) also omits the `session` field. Binding is decided by `getDefaultScope()` (`settings.ts:9,29`, user setting `defaultJobScope: "workdir"`), and `tool.ts:88-89` omits `session` when scope is workdir. The `details.jobs` payload is not model-facing text.
Reachable failure: with `defaultJobScope: "workdir"` configured, the added job is unbound and every pi in the cwd (including worker panes) loads and fires it (scheduler.ts:60-62) — duplicated hourly wake-ups across sessions, and the model can never execute the instructed verification, so the scope error is never reported. The prompt-level contract is unverifiable by construction.
Minimal fix: reword to what the tool actually exposes — verify scope by checking the scheduler settings/jobs file or the `/schedule-prompts` UI, or state plainly: "if the tool result does not confirm session binding, report that binding could not be verified and point the user at /schedule-prompts" — instead of asserting the model can "verify the returned session".

### 2. MEDIUM — scheduler `cleanup` destroys user-disabled jobs, contradicting the retention promise
`src/prompts.ts:329` promises to "retain ... enabled/disabled state unchanged; never recreate, overwrite or re-enable it"; `src/prompts.ts:326` and the plan doc claim human-edited schedules are untouched. But `pi-schedule-prompt/src/tool.ts:188-215` (`cleanup`) removes **all disabled jobs loaded for this session**, including a `goals-<sessionId>` job the user deliberately disabled ("Unbound disabled jobs are fair game" — and session-bound disabled jobs too). The completion prompt (`prompts.ts:352` → `removeGoalSchedule`) hands the model a schedule_prompt mandate right when tidying is likely. Parent UAT has now confirmed disabled-job deletion as a real gap.
Minimal fix: in `removeGoalSchedule`/`scheduleCheckIn` explicitly forbid the `cleanup` action ("remove only by jobId; never run cleanup — it deletes jobs the user disabled") and record the limitation in the plan/AGENTS.md claim.

### 3. MEDIUM — two supervising sessions can attach the same plan; no cross-session writer guard outside solo
`src/prototype.ts:340` (attach guard) and `:376` (new-goal guard) only check *this session's* worker/mode. Nothing detects that another session is already supervising the same plan path. Session A supervises plan P (watcher live, scheduler job goals-A); user attaches P in session B via `/goals attach P` (non-solo → planning, no confirmation), B reaches Ready and launches worker 2. Result: two writers, two independent watchers both firing plan-change reviews at their own sessions, and duplicate `CompleteGoal` authority — signoffs live in per-session `appendEntry` state (prototype.ts:56), so each session signs off the same goal independently and both write competing Log entries. The "two writers must not run together" discriminator is tested only for the solo transition (test/prototype.test.ts:221,306).
Minimal fix: at attach (and again at Ready), inspect the plan note / scheduler job list for another bound supervisor (`- worker session:` note plus a live `goals-<otherSession>` job) and route through a `confirmSolo`-style explicit confirmation when found. Prose alone ("Do not start a second writer") is the same guard class the design elsewhere rejects as insufficient.

### 4. MEDIUM(LOW) — the supervisor's own plan edits trigger a plan-change review of itself; observed in UAT
`src/prototype.ts:150-170` (`watchPlan` debounce → `send(planChangedReview(...))` at :168 with `triggerTurn:true`). Own-write suppression exists only for `CompleteGoal` (:447-449) and `/goals model` (:322). A supervisor editing a requirement/subtask above the fold with its normal edit tools changes the `planViews(...).short` hash and fires a full "Plan changed — inspect..." review turn at itself. UAT observed this ("One extra event-hook review followed the supervisor's own plan edits", herdr review doc). Each such edit costs a turn and an edit→review→edit loop is plausible while the model restructures the plan.
Minimal fix: in the same extension-owned write paths set a short-lived `selfWrite` stamp and skip the notification when the debounced read still matches the session's last written content; otherwise document that self-edits intentionally cost one review turn.

### 5. LOW — pauseExitNotice instructs `subagent_kill` with a sessionFile when the worker handle has no id
`src/prompts.ts:357-358`: "stop the tracked worker ${worker.id ?? worker.sessionFile} through subagent_kill or its pane". After `attach` restores a noted worker, the handle is `{ sessionFile }` with no `id` (prototype.ts:345), and `subagent_kill` requires the edxeth runtime `id` (prototype.ts:203-206 checks that property exists). A path is not a valid kill id; the model will fail the kill before falling back to the pane.
Minimal fix: branch the notice on `id` presence — with only a sessionFile, say "inspect liveness and stop it in its pane; no runtime handle is recorded for subagent_kill".

### 6. LOW — refresh() leaves a stale widget when the plan read fails
`src/prototype.ts:113-116`: on `readPlan()` failure the status bar shows the error but `setWidget` keeps the previous (possibly signed-off) lines, so during a transient unreadable/truncated-save window the widget presents stale completion claims as current. Minor, but the widget is the user's "task list" per the design note.
Minimal fix: on the error path also push/annotate the widget (e.g. `["plan unavailable — widget stale"]`) or clear it until the next successful read.

### 7. LOW — watcher error path is dead-end: plan-change reviews silently stop until a mode transition
`src/prototype.ts:171-173`: `planWatcher.on("error")` only notifies; after a directory-level watcher error (e.g. `.pi/plan/` renamed/recreated by an editor or user) Node's watcher is finished, no re-arm occurs, and `planHash` goes stale — later real plan edits produce no review until stop/resume/ready recreates the watcher.
Minimal fix: on error, close and null the watcher, and attempt re-arm in the existing `agent_end`→`refresh` path when `state.mode === "supervising"` and no watcher is live.

### 8. INFO — residual validation gaps (do not block, but the plan/UAT claims overstate coverage)
- Confirmed by parent UAT, not yet root-caused or fixed: delayed crash when the worker exits some time after a supervisor reload ("reload → worker-exit" sequence). Until reproduced, do not claim reload-lifecycle acceptance; the herdr doc itself says live-parent reload "remains pending"/crashed.
- No test or live trial of the hourly interval actually firing in the owning session ("No timer firing yet tested"); the plan doc's discriminator "shortened test interval fires once" is unmet.
- Worker-model verification (subtle failure "trial inherits supervisor model") is prompt guidance only; no test asserts the resolved model is surfaced anywhere the supervisor checks.
- Finding 3's two-supervisor scenario and findings 1/2's scope/cleanup behavior have no test coverage; the 158 passing tests exercise prompt text, not installed-package behavior.
- `refresh()` deletes signoffs inside the loop calling `save()` per deletion (prototype.ts:124-128) — benign today, but a batched save would avoid N appendEntries per refresh.

## Verified OK (checked, not just claimed)
- Line-index safety of `CompleteGoal`'s tick edit: `goals()` folds at `## Log`, goal lines precede the fold, so indices into `foldPlan` match the full text; log entry is spliced below the fold and excluded from `planHash` via `planViews.short`.
- `tool_call` gate correctly still permits `subagent_kill` in paused/solo (only `subagent`/`subagent_resume` blocked, prototype.ts:240-244), matching the pause notice's instruction to stop the worker.
- `confirmSolo` invalidates on generation, workerRevision, and plan-content change after the await — the post-await race flagged in the earlier review is genuinely fixed.
- Intercom draft preservation and "receipt ≠ action" are consistent with `pi-intercom/index.ts:1181-1203` (injection receipt emitted at delivery; steer/trigger delivery only) — the prompts' skepticism is warranted and correctly worded.
- All model-facing strings for the prototype live in `src/prompts.ts` in the required narrative order; no timer/transport framework was built; repo lifecycle defaults unchanged.
