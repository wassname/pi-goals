# Supervisor through pi-subagents

User, this session: "Another take on my pi-intercom-supervisor but using pi-subagents not a seperate user started terminal. I want to keep it simple by using pi-vcc pi-subagents where possibe"

Branch: `experiment/subagent-supervisor`. Supersedes the custom session-switching plan. Authored by Pi/Codex.

## User-visible result

The main agent is the cheaper worker. A stronger supervisor keeps the high-level intent and gives research direction from compressed context. It checks every 60 minutes and when the worker settles without background work, and judges goal sign-off against the plan and work history. Inspect and guide it through normal pi-subagents controls. No new terminal or custom session-switch command.

- [ ] goal: Keep supervisor context through ordinary pi-subagents continuation
  - [ ] At Ready, fork the approved-plan conversation and compact the supervisor's copy before its first review. Leave worker context unchanged. Keep runtime registration and a separately selected supervisor model; retain the latest run ID and reconcile on reload.
  - [ ] Resume that supervisor with VCC summaries of worker updates, current work status, and the full plan path. Include the worker compaction summary when an update crosses a compaction boundary; do not replay raw worker turns at check-ins.
  - [ ] Compact supervisor context at about 100k tokens, earlier if its model requires it. Preserve human intent, research decisions, rejected ideas and reasons, unresolved questions, and evidence references. Prefer package compaction support; verify the child-specific API before implementation.
  - [ ] Preserve supervisor decisions through continuation; avoid duplicate worker snapshots. Reuse relevant pi-supervise view logic, not its intercom transport or process scan.
  - [ ] Enable normal progress visibility; remove the bespoke visit/role-restoration design and arbitrary read-tool cap.
  - failure modes: fresh reviews forget earlier corrections; stale snapshots hide a human correction; review instructions start another supervisor.
  - deliverable: a real resumed child refers to an earlier correction and a later worker update in its next decision, visible through Fleet.

- [ ] goal: Use one supervisor check path for hourly and idle checks
  - [ ] Replace direct auto-continue and stale-turn review dispatch with an hourly timer plus settled/background-completion events.
  - [ ] Query pi-subagents status and pi-processes' request/reply protocol; do not infer activity from tool names, elapsed time, or missing results.
  - [ ] Exclude the supervisor itself; include nested work and queued completion delivery. Unknown status is an error, not proof of idle.
  - [ ] Serialize checks; recheck idle before dispatch and before waking the worker. Apply redirects once to the owning worker session.
  - [ ] Remove the two-wake pause. Human messages do not disable supervision. Keep the hourly check armed while the worker is stopped or busy; explicit off/clear or completed goals end checks.
  - failure modes: duplicate supervisors; normal async waiting mistaken for abandonment; supervisor completion triggers an endless self-review loop.
  - deliverable: hourly checks while busy, idle checks only without remaining work, and a supervisor redirect that actually restarts a stopped worker.

- [ ] goal: Sign off from the same informed supervisor
  - [ ] Route CompleteGoal through the same serialized check path with explicit sign-off mode; retain existing plan evidence and ticking behavior.
  - [ ] Only accept/reject decides sign-off; checkpoint advice cannot tick a goal. A failed review cannot approve anything.
  - failure modes: the supervisor accepts the worker's claim without reading the cited artifacts; a sign-off request received during a checkpoint is never processed.
  - deliverable: reject a plausible claim without evidence, then accept its proven result using the retained supervisor context.

## UAT / verification

- Context: verify the first review receives a compacted fork, later checks receive summaries, and supervisor compaction occurs near 100k tokens. Success retains earlier corrections through both agents' compactions; likely failure forgets them; subtle failure retains the plan but omits a newer user correction. Inspect actual model context, not just the saved transcript.
- Cost and usefulness: record worker/supervisor input, cached input, output, compaction usage, and cost separately. Test the hypothesis of roughly 10x lower supervisor token use; do not infer it from context size alone. Record concrete supervisor corrections and worker outcomes. A cheaper run alone does not demonstrate better research decisions.
- Triggers: fake-clock tests exercise 60 minutes during busy work and after repeated stops. Success also waits for an already-running child/process; likely failure never wakes; subtle failure counts its own supervisor or treats a completed launch call as finished work. Test nested work, completion delivery, overlap, reload, off, and all-goals-done.
- Sign-off: exercise missing evidence, positive artifact evidence, and concurrent checkpoint/sign-off. Check the saved decision and actual plan checkbox, not only mocked helper output.
- Run repo tests, typecheck, lint, and a real spawn/resume/redirect/sign-off test with normal Fleet visibility. Save local run artifacts outside tracked research/source files. If a check fails, inspect its source events and fix the cause; do not substitute a separate terminal.

## Appendix: ownership and flow

```text
Ready: fork approved-plan conversation -> compact child copy -> stronger supervisor
Every 60 minutes: request checkpoint, even if worker has been busy
Worker settled / background work finished: reconcile; request idle check if no work remains
CompleteGoal: request sign-off with claim + plan + VCC worker view

One check at a time -> resume with VCC update -> store latest run ID
Supervisor context near 100k tokens -> compact its context, retaining decisions
  checkpoint/idle -> let_run or redirect worker with one concrete next action
  sign-off        -> reject with missing evidence, or accept and tick goal
```

User clarification: "fork and compact because I hope to use a smarter model for the supervisor with better research taste." The initial supervisor input must be compacted, even if the worker has not compacted. Do not compact the worker as a side effect. Verify that inherited extension state does not start nested supervision.

Cost hypothesis, not an observed result: roughly one tenth of the token use could fund a model with roughly ten times the per-token price at comparable total cost. Measure cache pricing, output, and compaction separately. The intended benefit is better worker research decisions, not merely fewer supervisor tokens.

These are conceptual operations, not invented package API names. The parent extension supplies triggers and context; pi-subagents owns child execution, persistence, resume, control, and UI. The supervisor judges direction and evidence. It may finish each review turn; the next check continues its stored context. No claim that the same child process stays running.

Use a small parent-session timer: installed RPC `manage` does not expose schedule creation, and package schedules launch fresh workflows without automatically capturing current parent context. Do not use the package's budget-bound mission goal loop for this unlimited-duration supervision policy.

Sources read for this plan:
- [Supervisor research journal](../../../pi-supervise/RESEARCH_JOURNAL.md): user preferences, premature-stop bug, VCC context, stale-snapshot accumulation.
- [pi-subagents extension API](/home/code/.pi/agent/npm/node_modules/pi-subagents/docs/extension-api.md): runtime registration, RPC spawn/resume/status, exact-session completions.
- [Execution controls](/home/code/.pi/agent/npm/node_modules/pi-subagents/skills/pi-subagents/references/execution-controls.md): retained continuation, latest run identity, schedules, native parent contact.
- [Observability](/home/code/.pi/agent/npm/node_modules/pi-subagents/docs/observability.md): Fleet transcripts, `s` guidance to live async children. Enter opens an optional Herdr inspector, not a TUI session switch.
- [Process client](/home/code/.pi/agent/npm/node_modules/@aliou/pi-processes/extensions/processes/client.ts): existing request/reply list protocol. Verify ownership/scope in the handler before integrating; never silently interpret a missing reply as an empty list.
- [Existing VCC view](/home/code/.pi/agent/git/github.com/wassname/pi-supervise/src/view.ts): reuse context construction selectively; its process scan and intercom byte limits do not belong in this branch.
