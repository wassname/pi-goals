# DeepSeek reviewer — package-based supervision (cb35fbf + uncommitted patch)

Scope: `src/prototype.ts` (426 vs 186 lines), `src/prompts.ts` (+88), `test/prototype.test.ts` (+397), `test/rpc-review.test.ts` (env sanitize), `AGENTS.md`, `prototype/README.md`, `prototype/agents/goals-worker.md` (repo default `auto-exit: true`). Evidence basis: full source reads, stock edxeth `953c6f6` reads, installed `pi-schedule-prompt/src` and `pi-intercom` reads at the exact provided paths, parent UAT captures `01–19`, and `slop/reviews/20260910_package-supervision-herdr.md`. Nothing executed beyond `vitest` logs already saved; no source edits, no panes, no messages.

Tests: saved logs show 158/158 pass + typecheck/lint pass. The suite does exercise the new gates well (stale-menu invalidation, watcher debounce, unavailable snapshot signoff retention, upkeep fold, child attach). It does **not** cover: real auto-exit vs keep-open behavior, the stock stale-ctx crash on worker exit after reload, scheduler disabled-job deletion across reload, or intercom worker identification with multiple children — those are only covered by the parent's live captures, and the unit fake cannot prove UI/source acceptance.

---

## Findings (max 8, prioritized)

### 1. [Observed — HIGH] Repo default `auto-exit: true` discards unsent human drafts at every worker terminal turn; `auto-exit: false` + Intercom preserves the draft but does not fix the delayed reload crash
- Source: `prototype/agents/goals-worker.md` frontmatter `auto-exit: true` (repo default, unchanged); agent prose "Normal completion returns your report and closes this pane".
- Repro: parent captures `08` (auto-exit closed w8:p6E and lost `UNSENT-WORKER-DRAFT-KEEP`, while the worker's own tool result proved the Intercom reply had been delivered) and README "Known trial failure". With an isolated `auto-exit:false` profile, capture `09/11/13/14` show live Intercom steering + the unsent draft surviving send, ACK, and a parent `/reload`.
- Minimal fix (package config/prompts only): flip the agent def to `auto-exit: false`, update the agent prose and `prototypeSupervisor` (see finding on "Reports arrive automatically"), and make the child report completion via an Intercom message to the parent id it receives in `from.id` / discovers via `intercom list`. This is exactly the minimal-adoption route the plan asks for — but see finding 2 before declaring lifecycle acceptance.

### 2. [Observed — HIGH] Delayed parent crash when a live open worker exits after a parent reload (stock edxeth, not pi-goals)
- Source/evidence: `slop/reviews/package-supervision-captures/17-delayed-reload-worker-exit-crash.txt`; stack `running-registry.ts:255 -> widget.ts:139` — stale ExtensionContext after reload, "This extension ctx is stale after session replacement or reload".
- Repro: parent reloaded with the keep-open worker alive (capture 14 passed for immediate re-targeting), then the worker exited normally (Ctrl+D) → the parent pane crashed on the stale callback.
- Impact: the whole "reload with a live worker" story (which `auto-exit:false` depends on) is not lifecycle-safe until this stock behavior is understood or avoided. `auto-exit:false` preserves the draft and steering but does not fix the eventual worker-exit crash (observed — this crash occurred in the keep-open configuration).
- Minimal mitigation within constraints: after a reload, do not rely on a normal worker exit; recover via saved-session restart + `/goals attach <plan> solo` (validated: capture `19` — exact bytes `solo-ok\n`, `Solo self-verification` log, original `hello.txt` preserved). README already bounds the claims; keep it that way and do not change repo lifecycle defaults until the crash trigger window is pinned.

### 3. [Observed — MEDIUM] Disabled owned scheduler job is deleted by the installed scheduler, contradicting `scheduleCheckIn`'s "retain disabled" instruction; check-ins then silently stop
- Source: installed `pi-schedule-prompt/src/index.ts` `autoCleanupDisabledJobs` — deletes own/unbound disabled jobs on `session_shutdown` and on non-startup `session_start` (verified in the installed source; parent observed the deletion in the trial). `src/prompts.ts:328` `scheduleCheckIn` tells the model to "retain its human-edited prompt, interval and enabled/disabled state unchanged; never recreate, overwrite or re-enable", and `:332` "Do not reinstall a missing job from a scheduled check-in".
- Repro: create the owned job, disable it via `/schedule-prompts`, `/reload` → job gone; no ready/resume prompt is re-sent on reload, so nothing ever informs the model — hourly check-ins stop silently, and the "retain disabled" guidance is unachievable.
- Minimal fix (prompt-level): tell the model that a disabled owned job may be auto-cleaned at reload, and instruct it to surface that to the user (report-and-ask) instead of silently re-adding or silently ignoring. Optionally persist user intent (disabled) in the extension STATE entry so reload can restore it deliberately.

### 4. [Inferred — MEDIUM] Job add/remove guidance mismatches the scheduler API: auto-named jobs, and removal by name while the API needs `jobId`
- Source: `pi-schedule-prompt/src/tool.ts:72` `const jobName = params.name || \`job-${nanoid(6)}\``; `:128-141` `remove` requires `jobId`; `src/prompts.ts:328` `scheduleCheckIn` never instructs the model to pass `name: goals-<sessionId>`; `src/prompts.ts:325` `removeGoalSchedule` says remove "the job named `goals-<sessionId>`".
- Repro: model adds the job without a name → it is `job-<nanoid>`; later removal guidance looks for a name that does not exist. List-first mitigates (and capture 19 shows the solo completion log correctly listing an empty job list), but a model that skips the list step can fail to remove the owned job, leaving a stale hourly prompt firing into a completed/paused session.
- Minimal fix: instruct add with the explicit owned name and removal by the listed `jobId`; keep "leave other jobs untouched".

### 5. [Inferred — MEDIUM] `workerStopped` can never be set by an actual stop; the confirm menu is the only stop-recording path
- Source: `src/prototype.ts:291` records the worker on launch/resume success only (`subagent`/`subagent_resume`); there is no `subagent_kill` result hook, and the detached async completion is delivered as a steer message, not a `subagent` `tool_result` (stock `running-registry.ts` `getStartedSubagentResult` returns immediately for async). `workerStopped: true` is only assigned in `enterSolo` (`:214`) and in `attach ... solo` (`:345`).
- Repro: worker completes and auto-exits (current default) → the parent sees the completion steer but `state.workerStopped` stays false → `/goals attach <new-plan>` (non-solo) and any new objective stay blocked (`:340`, `:376`) until the user runs `/goals solo` and confirms. Safe (no duplicate writer), but the recorded handle is permanently "possibly live" and exit alone never unblocks plan replacement.
- Minimal fix: document in README/help that the solo-confirm menu is the only path that records a confirmed stop, or add an explicit "worker confirmed stopped" command that sets `workerStopped=true` after the user inspects `subagent_kill`/pane (still no liveness claim).

### 6. [Inferred — LOW/MEDIUM] No persisted mapping from the worker to its Intercom session id; identification after reload is name/cwd matching, fragile with multiple children
- Source: `src/prototype.ts:291` stores the edxeth runtime `id` (e.g. `8317cac5`) + `sessionFile`; the Intercom id (`003c8e70-...`) is different and only discoverable via `intercom list` (presence name `[goals-worker] <title>` from the launch title, `cwd`, id prefix — verified in `pi-intercom/src/index.ts` `buildPresenceIdentity`/`list` and capture `14`).
- Repro: parent reload with one open worker → re-target by list works (capture 14: `RELOAD-LIVE-ACK` from same session `003c8e70`, draft intact). With two open `goals-worker` children (e.g. after a mistaken duplicate resume), name/cwd matching is ambiguous, and nothing records the observed Intercom id for reuse.
- Minimal fix: when the supervisor identifies the live child (from a received message `from.id` or `list`), persist `intercomId`/name in `state.worker` and surface it in `/goals status` and the steering prompts.

### 7. [Inferred — LOW] `CompleteGoal` accepts a cancelled `[-]` goal and rewrites it to `[x]` with a recorded sign-off
- Source: `src/prototype.ts` `goals()` maps `-` to `"cancelled"`, the `CompleteGoal` match filter (`key(g.subject) === key(params.goal)`) does not exclude cancelled, and the tick replaces `[-]` with `[x]`; `prototypeMessages.cancelled` only guards signal abort.
- Repro: parent calls CompleteGoal on a goal the user (or plan) cancelled → the cancelled goal becomes done+reviewed, changing the widget and `remaining` accounting.
- Minimal fix: exclude `status === "cancelled"` from the `CompleteGoal` match (and from `ready`'s delegation scan).

### 8. [Observed — LOW] Real-model planning trap (not a source defect): first draft misread the unquoted literal
- Evidence: parent review — first draft made `hello from the worker` six bytes, split file+verification into two goals, and called uncommitted deliverables a failure; one parent clarification fixed it, after which Ready → worker → byte-verified completion ran autonomously, and solo fallback (capture 19) also completed.
- Suggestion (untested): the drafting prompts already mandate quoting in `## User voice`; add one concrete literal-quoting example (an exact-byte file target) to `planDrafting`/`prototypePlanning` so future models see the expected precision. Not a code change.

---

## Direct questions

### Can no-autoexit + live Intercom replace the completion handoff safely?
- **Report/steer/draft path: yes, observed.** Capture `09/14`: Intercom delivery preserved an unsent draft, ACK round-tripped, parent reload re-targeted the same open worker (`003c8e70`), draft intact.
- **Full lifecycle: no, observed.** The keep-open worker's later normal exit after a reload crashed the parent on stock edxeth's stale ctx (finding 2). `auto-exit:false` does not fix that. So no-autoexit + Intercom is safe *as a completion handoff while the worker stays open*, but every eventual worker exit after a reload is a crash risk; plan for pane/session-restart termination instead of normal exit, and validate before claiming lifecycle acceptance.
- **One hard dependency of the no-autoexit configuration:** with `auto-exit:false` interactive, stock edxeth registers neither `caller_ping` (requires `!isInteractive || autoExit`) nor `subagent_done` (never for interactive). The child has no edxeth completion tool at all — completion must be an Intercom message, and `prototypeSupervisor` (`src/prompts.ts:308`) currently says "Reports arrive automatically", which is only true for the auto-exit default. Flip the default and this sentence becomes false; the child-side prompts (`childPlanRole`, agent prose, readyApproved) also never instruct the child to send a completion Intercom message or give it the parent's Intercom id (it can take it from `from.id` of the first parent message, or `intercom list`). The agent-def flip and these prompt changes must land together.

### How to identify the existing worker after reload?
- Via `pi-intercom` presence list: `intercom({action:"list"})` shows the child's registered session — name `[goals-worker] <title>` (launch title), `cwd`, and a unique id prefix (`pi-intercom/src/index.ts` `list`; duplicate names are disambiguated with id prefixes). The child's Intercom session id is stable across the parent reload because the child process never reloaded. Target by the listed id prefix (capture 14: parent re-targeted `003c8e70`, received `RELOAD-LIVE-ACK`, no second worker launched).
- Pitfall: the stored edxeth runtime id (`state.worker.id`) is **not** the Intercom id; match by name/cwd, and persist the observed Intercom id once found (finding 6) to remove ambiguity with multiple children.

## Minimal stock-package integration advice (no runtime patches/framework)
1. Agent def: `auto-exit: false`; update agent prose ("stay open; report completion via Intercom") — package config only.
2. `src/prompts.ts`: remove/qualify "Reports arrive automatically" under keep-open; readyApproved/childPlanRole instruct child completion via Intercom to the parent id it learns from `from.id`/`list`; keep "do not start a second writer" and the liveness caveats (already good).
3. Scheduler guidance: add with explicit name `goals-<sessionId>`, remove by listed `jobId` (finding 4), and surface the disabled-job auto-deletion reality (finding 3, observed in the installed scheduler).
4. Lifecycle claims: keep the README bound (no auto rediscovery / crash recovery); use saved-session restart + `/goals attach <plan> solo` as the validated recovery (capture 19); do not change repo default until the stale-ctx crash (finding 2) is scoped.
5. Keep the branch-entry STATE persistence and the AttachGoalPlan child seam — they are what makes saved-session restart and solo recovery work; the parent's "PI_GOALS_SHARED_PLAN never set" finding is resolved by the removal of that env read and the explicit attach tool (`src/prototype.ts:387`).

## Remaining uncertainty (explicit, not re-explored)
- Exact trigger window/ordering of the stock stale-ctx crash (which callback, whether parent-reload-before-worker-exit is always fatal vs only certain timing) — untested, stock code, outside pi-goals.
- Whether the child's Pi session name reliably equals `[goals-worker] <title>` across stock edxeth launches (observed once) — naming could vary by edxeth version/overrides.
- Whether a model will reliably follow the list-first + jobId removal and the "report disabled-deletion" prompts — prompt-compliance only, no enforcement point exists.
- Real-runtime delivery of the upkeep message (`triggerTurn:false`, `src/prototype.ts:258`) — verified by unit mock only; actual Pi queueing behavior untested in UAT.
- The `- worker session:` plan note is only ever read (`src/prototype.ts:343`), never written by code or instructed by prompts; attach tests seed it manually — real-flow write path unverified.
