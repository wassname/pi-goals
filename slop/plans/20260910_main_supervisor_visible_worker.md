# Main supervisor and visible worker

## Superseded implementation direction

Wassname chose the shorter remote prototype `experiment/main-supervisor-edxeth` (`fb5503f`) and unmodified edxeth. Stop the runtime patch effort; preserve it as WIP in [the patch archive](../patches/abandoned-edxeth-persistent-worker/README.md). The checklist below is historical, not instructions to continue the fork.

Approved next work: commit/push this attempt, switch to that prototype, specify worker model in the plan, use installed pi-schedule-prompt for visible hourly check-ins, and add small plan-change review notifications. Check existing edxeth live messaging and Intercom/pi-messaging compatibility with a subagent before choosing any integration. Use existing token displays first; defer custom reporting. -- Pi/OpenAI

Use a strong main Pi supervisor and cheaper workers with the whole normal Pi interface. Preserve independent judgment while removing duplicated orchestration code. User wording and open decisions: [AGENTS.md](../../AGENTS.md#user-voice-redesign-discussion-2026-09-10).

1. [/] goal: Use a full interactive worker without losing autonomous supervision
   - [x] Open an isolated edxeth trial without installing or changing global settings; user has seen the worker UI.
   - [ ] Test direct interaction, `/model`, `/tree`, fast completion, reload/resume, and a stopped worker with background work.
   - [ ] Keep the worker available for human interaction while delivering its stopped-turn result; distinguish an open Pi pane from active work.
   - [ ] Reproduce lifecycle failures before patching the subagent package; do not rebuild its runtime inside pi-goals.
   - likely failure: direct interaction or completion closes the pane or loses the parent notification.
   - subtle failure mode: supervisor waits for human input, or claims completion while worker jobs still run.
   - discriminator: saved sessions show automatic parent review after work settles, plus normal worker interaction and recovery without duplicate work.
   - deliverable: usable test panes and a source-linked lifecycle review in `slop/reviews/`.
2. [ ] goal: Keep independent supervisor judgment with less execution detail
   - [ ] Review on stop with no active worker processes/subagents, every 60 minutes, and on plan checks or changes.
   - [ ] Choose the simplest hourly wake, evaluating session-bound `pi-schedule-prompt` without a model override; cancel reminders when supervision ends.
   - [ ] Show factual worker/review/delivery status. Use concise updates and evidence paths; inspect the actual files when needed.
   - [ ] Keep prompts editable and reuse existing compaction; no extra summarizing agent.
   - [x] Start permissive as approved: supervisor edits the plan and approves completion after independent inspection; worker implements and records evidence. Keep normal tools and editable role prompts.
   - likely failure: supervisor takes over implementation or needs the human to restart unfinished work.
   - subtle failure mode: short worker summaries hide a wrong result and the supervisor accepts it without inspection.
   - discriminator: supervisor rejects a plausible wrong artifact, explains the evidence, and gets the worker to correct it; separate session usage shows where tokens went.
   - deliverable: editable prompts and a recorded independent review/correction cycle.
3. [ ] goal: Reduce pi-goals to planning and goal review
   - [ ] Preserve plan files and explicit Ready; remove replaced transport, launching, worker views, and model state after the trial passes.
   - [ ] Replace Nicobailon-specific status assumptions with the selected runtime's actual activity contract.
   - [ ] Update tests and current documentation; then replace the old global subagent package after the successful trial, never load both together.
   - likely failure: old and new runtimes conflict or stale commands remain advertised.
   - subtle failure mode: code moves into a new wrapper without reducing duplicated responsibilities.
   - discriminator: one subagent runtime owns workers; the deletion diff and real end-to-end session demonstrate retained behavior.
   - verify: `npm test && npm run typecheck && npm run lint` with full output saved.
   - deliverable: reviewed branch diff and working two-model setup.
4. [ ] goal: Find and inspect supervisor/worker pairs with separate usage and code provenance
   - [ ] Add a script in the subagent fork to list pairs and inspect their sessions, behavior evidence, and input/output/cache token usage.
   - [ ] Record Pi/package versions, tested source commits and dirty changes at launch; mark unrecoverable historical information unknown.
   - likely failure: worker sessions cannot be matched to their supervisor or resumed runs disappear.
   - subtle failure mode: parent totals already include worker usage, or a clean commit label hides uncommitted tested code.
   - discriminator: script finds the real trial pair, matches raw per-session usage without double counting, and identifies its tested code and interventions.
   - deliverable: runnable pair-inspection script, focused tests, and a saved report for the trial pair.

## UAT / Verification

- Use only parent-created test panes and a temporary Git repo; never interrupt the user's other projects. Show normal worker UI, direct interaction, independent correction, and reload/resume.
- Exercise all three review triggers, using a short test-only hour interval then inspecting the configured 60-minute value; run the pair-inspection script on these sessions.
- Save both session paths, pane captures, actual artifact and verification output, versions, token usage, and every manual intervention. A UI preview or receipt is not autonomous success.
- Diagnose exact failures from both sessions, patch the responsible component, and repeat the failed scenario. Keep unresolved behavior explicit.

## Appendix (context, not approved)

Branch: `experiment/main-supervisor-visible-worker`, based on `2a7c490`. Existing unrelated dirty files are preserved. [Initial trial and interview](../reviews/20260910_edxeth_ui_trial/notes.md). Wassname approved proceeding with "sounds good"; isolated lifecycle validation is first. Wassname then approved permissive supervisor plan/completion ownership and implementation with "so yes, do it". Lifecycle reports: [observed test](../reviews/20260910_edxeth_ui_trial/interactive-lifecycle.md), [runtime and pair-script contract](../reviews/20260910_edxeth_ui_trial/minimal-runtime-contract.md).

-- Pi/OpenAI
