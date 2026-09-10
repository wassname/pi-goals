# Package-based supervision

User intent and exact preferences: [AGENTS.md](../../AGENTS.md#agreed-package-based-design-2026-09-10). Use existing packages, keep the main supervisor small and visible; do not continue the edxeth patch.

1. [x] Preserve our attempt and switch to the short prototype
   - evidence: pushed WIP commit `2803505` on `experiment/main-supervisor-visible-worker`; includes abandoned edxeth source patch and pi-goals test log (`165 passed`). This is not acceptance of the patch.
   - current branch: `experiment/main-supervisor-edxeth`, HEAD `cb35fbf1feed9d4cea2f9675917adfe602c2835c` (fast-forwarded latest remote research-only commit).
2. [/] goal: Supervise a full Herdr worker using unmodified edxeth
   - [x] Adopt remote prototype; source-check existing messaging and scheduling packages.
   - [x] Preserve main's useful features: plan/subtask widgets, plan-upkeep reminders, material planning questions, and context restoration after compaction. (prototype widget now shows open subtasks of the active goal; scheduleCheckIn carries the upkeep reminder; prototypePlanning keeps questions to one material round and records unknowns; before_agent_start re-pushes the full plan after reload/compaction; prototypeSupervisor repeats the plan path).
   - [x] Move ALL model-facing text into `src/prompts.ts` in narrative order; finish small prompt/model changes and regression tests. (new prototype section in prompts.ts: planning -> Ready -> supervision -> check-ins -> completion -> pause/resume/exit -> solo -> attach; 35 prototype tests + the full suite pass; lint + typecheck clean.)
   - [/] Verify worker uses the model specified in the plan; prefer DeepSeek Flash or GLM Flash for cheap tests. User also permits “codex lunda on plan 2”; resolve actual provider ID before using it. (prompt guidance + `/goals model <model>` writes the preference into plan preferences and `/goals status` shows it; REAL worker-model verification remains part of parent-owned Herdr acceptance with `accounts/fireworks/models/deepseek-v4-flash-0731` which is available.)
   - likely failure: auto-exit closes the pane before a live message arrives; follow-up must use saved-session resume after exit.
   - subtle failure: trial inherits supervisor model rather than requested worker model.
   - discriminator/deliverable: saved supervisor and worker transcripts identify the models used and show the supervisor checking the worker's output against the requested result.
3. [/] goal: Visible hourly check-ins and plan review without another scheduler
   - [x] Finish prompt-based schedule_prompt integration: one session-bound 1h job, no model override, list before add, remove on pause/exit/completion. (scheduleCheckIn: list first, one owned session-bound job named goals-<sessionId>, retaining existing human-edited prompt/interval/disabled state, type interval 1h, no model override, job prompt reads the plan fresh, remove only that job on pause/exit/completion, keep human-edited schedules untouched, report unavailable instead of building a timer.)
   - [x] Test plan-directory watcher and `/goals review`; coalesce duplicate events and clean up on lifecycle changes. This is an event hook, not another scheduled loop. (150ms debounce before reading/refresh, classified unavailable snapshots retain signoffs, existing high-level plan view excludes task/evidence/Log maintenance while retaining requirements/manual ticks; tests cover atomic replacement, bursts, shutdown/reload and own writes.)
   - [x] Show users how to inspect, edit and remove hourly jobs through the scheduler UI; changing its prompt must affect subsequent check-ins. (`/goals status` names the goals-<sessionId> job and distinguishes the schedule_prompt job from the plan-watcher event hook; prompting points the job at the plan path.)
   - likely failure: scheduler unavailable or configured project-wide; show missing capability, do not silently add a timer.
   - subtle failure: stale reminder resumes paused work, or duplicate jobs/review notifications create a loop.
   - discriminator/deliverable: shortened test interval fires once in owning supervisor, reload does not duplicate it, stop/completion removes only its job, unchanged plan does not retrigger.
4. [ ] goal: Use pi-intercom for live messages where edxeth reports/resume do not fit
   - [ ] Test stock packages in isolated parent-created Herdr panes: parent targets listed child session ID, busy/idle messages arrive without changing a human draft, observe auto-exit behavior.
   - likely failure: wrong or departed target session.
   - subtle failure: delivery receipt is mistaken for worker receipt/action or message disables normal reporting.
   - discriminator/deliverable: actual message and worker response in both session logs; no custom transport or edxeth patch.

5. [x] goal: Explicit solo recovery retains planning features without claiming independent review
   - [x] Confirm any worker has stopped before takeover; preserve the plan, evidence and widget. Main thread may implement and edit in solo mode. (`/goals solo` and `/goals attach <path> solo` share a generation-checked select confirming all other writers stopped: “Worker confirmed stopped / Cancel”; solo blocks subagent and subagent_resume; completion text labels solo as self-verification, not independent review; /goals attach <plan.md> [solo] connects an existing plan, restores a `- worker session:` note for subagent_resume reuse and never claims liveness. Tests cover both transitions.)
   - failure/discriminator: a stored worker handle must not permanently block solo after confirmed termination, and two writers must not run together. Test both transitions and label completion self-verification.

6. [ ] goal: Publish the reviewed changes and switch the normal Pi installation
   - User authorization: “ok once done commit and push. then change out install to use this and it's deps pls”.
   - [ ] Resolve review findings, simplify, rerun tests and inspect final interactive evidence; do not treat the known edxeth reload crash as a passed check.
   - [ ] Commit scoped source/tests/evidence and push `experiment/main-supervisor-edxeth`; preserve unrelated dirty and human files.
   - [ ] Read Pi package docs and yadm guidance, then replace the conflicting installed goals/subagent entries with this reviewed branch and clean unmodified edxeth. Retain schedule-prompt and Intercom; preserve unrelated packages/settings.
   - discriminator: inspect resolved package paths/versions and verify one goals entrypoint and one subagent implementation in a fresh visible test session. Save rollback instructions. Do not reload or close existing user sessions automatically.

## UAT / Verification

- User authorized execution, testing with Fireworks DeepSeek V4 Flash, then an external code review. Review must cover failed compaction, exhausted credits in either session, reload/reconnection, leaving planning, and attaching an existing plan to one (solo) or two (supervisor/worker) sessions without restarting completed work. Keep this a small explicit recovery path, not a replacement runtime.

- Run `npm test && npm run typecheck && npm run lint` with full saved logs, then inspect actual isolated Herdr results. Tests do not prove interactive compatibility.
- Use only new test panes; never operate existing user/demo panes. This parent had `HERDR_ENV=1`, `HERDR_PANE_ID=w8:p62`; recheck after compaction. Headless subagents may lack Herdr context.
- Read failed outputs, fix their cause, retry the affected scenario. No global package switch until successful trial. Reuse existing token displays; custom pair/token scripts are deferred.

## Installed result — Pi/OpenAI, 2026-09-10

- Implementation and evidence pushed on `experiment/main-supervisor-edxeth` through `5cda3d6`. 162 tests, typecheck and lint pass. Both external native reviews completed; final current result and interventions are at the top of the functional trial notes.
- Normal `/home/code/.pi/agent/settings.json` now selects this local checkout instead of the unpinned git source and `/home/code/.pi/agent/git/github.com/wassname/pi-subagents-stock-validation` instead of `npm:pi-subagents`. Stock edxeth is detached at `953c6f6`; its existing dependency directory is symlinked from pi-goals. Intercom and scheduled-prompt package entries are unchanged. Local paths avoid Pi reconciliation overwriting unrelated dirty files.
- `/home/code/.pi/agent/agents/goals-worker.md` points to this repo's worker definition. The existing agents-directory symlink had a missing target; created that target without replacing the symlink. Settings and worker path were not yadm-tracked.
- Fresh normal-profile pane `w8:p6M` successfully loads `/goals status` and the stock `/subagents` UI with Orchestrator Off. Existing user sessions were not reloaded. Start a new Pi session to use this installation; stop workers before any later supervisor reload.
- Rollback: restore package entries `npm:pi-subagents` and `git:github.com/wassname/pi-goals` in settings, and remove only the new goals-worker symlink. Do not load both subagent packages. This does not require deleting either source checkout.
- Remaining limits: stock reload crash, disabled scheduler-job deletion, idle worker widget snapshot not immediately refreshed, human-attested ownership/stop checks. These are documented, not claimed fixed.

## Earlier parent handover (historical)

- Authoritative latest UAT: [functional trial notes](../reviews/20260910_package-supervision-herdr.md). Solo recovery after restarting saved supervisor passed with exact files and self-verification log. Timer prompt update/firing/removal passed. Disabled jobs are deleted by scheduler on reload. Parent reload kept worker usable, but later worker exit crashed parent in stock edxeth stale-widget callback; full reload lifecycle FAILS.
- Native `/review` workflow `a1bcfc11-0212-410e-aad7-6fd704f7e9c6` has DeepSeek and GLM reviewers; exact child ids and search interruption evidence are in UAT notes. Broad find processes were terminated, both reviews resumed using exact package paths. Wait for their native completion; do not launch duplicates. Earlier Claude CLI attempts were a mistaken route for the requested /review skill.
- User now authorizes commit, push, then normal install/dependency switch WHEN DONE, not before review/validation. No new source commit or global install changes yet. Current trial pane w8:p69 is restored and in solo mode; all test worker panes closed, scheduler store empty. Do not touch user/demo panes.
- Measured source growth: prototype.ts 186 -> 426 lines, plus 88 new prompt lines. Simplification still needed; don't claim code shrinkage or full main-feature parity without checking.

## Handover: continuation checked, 2026-09-10

- Source snapshot remains uncommitted on `experiment/main-supervisor-edxeth` at `cb35fbf`; no branch/global-package/lifecycle-default changes and no pane reloads by the continuation worker. This resumed implementation run resolved `gpt-6-astra`, not the original Fireworks model. Parent's visible UAT sessions remain Fireworks.
- Fixed the parent's confirmed paths: shared solo/attach stop confirmation with stale-menu guards; retained stopped-session references allow later plan replacement; in-flight launch blocks takeover. Solo closes watcher/debounce and requests removal of only the owned session-bound job. Scheduler prompts preserve existing disabled state and human edits; context resync never reinstalls jobs.
- Missing, empty and failed plan reads are classified unavailable snapshots, not authoritative empty plans. Debounce occurs before refresh; signoffs survive transient saves and failed resync, then context retries after repair. Cancelled goals do not keep completion open. Solo's saved ## Log record says self-verification.
- Explicit child-only `AttachGoalPlan` binds the absolute path supplied in the task, persists it, and restores the widget/subtasks and compaction context without granting CompleteGoal permission. No PI_GOALS_SHARED_PLAN discovery or runtime patch. Ready supplies the attachment instruction. Stock `953c6f6:src/launch/prep.ts:461` sets PI_SUBAGENT_AGENT; this is the child-role seam used.
- Reused `planViews` for high-level requirement/manual-tick notifications without maintenance-only review loops. Reused main's folded working-set staleness idea: every eight unchanged turns, solo/supervised/attached-worker context gets upkeep via a context-only custom message, never a second timer or forced agent turn. All prototype model-facing role/completion/error text is in src/prompts.ts; public controls are documented in prototype/README.md.
- Validation: `npm test` **158/158 PASS**, `npm run typecheck` PASS, `npm run lint` PASS. Logs: `slop/test-logs/continuation-full.log`, `continuation-typecheck.log`, `continuation-lint.log`. Focused prototype coverage: 35 tests. RPC also passes with deliberately inherited `PI_SUBAGENT_CHILD=1 PI_GOALS_ROLE=supervisor`: `continuation-rpc-child-env.log`.
- Correction to the original handover: the RPC timeout did NOT establish a headless/sessionless incompatibility. The fixture inherited child role variables, and src/index.ts excludes children from main registration. The fixture now sanitizes PI_SUBAGENT_* and PI_GOALS_* for its spawned MAIN process. Prior categorical RPC/UI claims are withdrawn; no stash or human-file round-trip was used in this continuation.
- Parent real UAT produced exact hello bytes and verified Intercom in both directions with an unsent draft surviving message delivery. Stock auto-exit:true then closed the worker and lost that draft (model prose falsely claimed there was none). Parent's isolated auto-exit:false + Intercom completion trial subsequently passed open-pane follow-up/OPEN-PANE-ACK with the draft retained. Parent reload with the live open worker remains pending. Repository lifecycle defaults are deliberately unchanged until that result; no new trial was launched by this worker.
- External Claude review remains separately blocked by the installed runner's version-output regex. No CLI fallback or global runner edit; external review is still required. Parent owns the live trial report and captures under slop/reviews/.
- Preserve unrelated AGENTS.md, `.local/`, `docs/human_journal.md` and review-fixes-native event files; none edited or staged in this continuation.
