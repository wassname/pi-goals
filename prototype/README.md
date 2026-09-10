# Main-chat supervision

Planning and supervision stay in the main Pi session. `goals-worker` runs in a visible Herdr pane with normal tools. It reports through pi-intercom and stays open, so completion does not discard an unsent editor draft. The supervisor reads actual artifacts before `CompleteGoal`; solo mode records self-verification instead.

## Packages

- This branch loads `src/prototype.ts`; model-facing text is in `src/prompts.ts`, in conversation order.
- Unmodified [edxeth/pi-subagents v2.9.0](https://github.com/edxeth/pi-subagents/tree/953c6f6d2fc7d8a5c956c30cd77c51bad697c2a4), not the conflicting nicobailon npm package `pi-subagents`. Never load both implementations.
- Installed pi-intercom handles live messages. The worker receives the supervisor's session ID in its task; record the worker's saved-session path and actual Intercom ID in plan preferences. Runtime IDs are not Intercom IDs.
- Installed pi-schedule-prompt owns hourly check-ins. No additional recurring timer or message transport is implemented here.
- `prototype/agents/goals-worker.md` uses `auto-exit: false`, `parent-close-policy: continue`, lineage-only context, and normal extensions/tools. Do not enable edxeth's restricted orchestrator mode.

## Use

1. `/goals <objective>` drafts a plan and asks material unresolved questions. `/goals review` opens Ready / Discuss / Edit / Cancel; `/goals ready` approves directly.
2. Ready delegates the first unfinished goal. Include the requested worker model in plan preferences or use `/goals model <provider/model>`; verify the actual selected model.
3. The worker calls `AttachGoalPlan` with the supplied absolute path for its widget/context. It sends evidence and progress through Intercom, not an exit-only completion tool.
4. Inspect and message a live worker using its listed Intercom ID. Use `subagent_resume` with its saved-session path only after it has stopped; never start another writer just because a report is late.

## Controls and recovery

- `/goals status`: mode, plan path, model preference, saved worker session and scheduler-job name. A recorded handle does not prove liveness.
- `/goals stop` or `/goals exit`: pause/leave goal mode, retain the plan, and request actual worker stop plus removal of the owned check-in job. Remote termination is not assumed.
- `/goals resume`: explicitly continue a paused plan after checking existing workers.
- `/goals solo`: confirm all other writers stopped, then let this main session implement and edit. Completion is labelled self-verification. The saved worker reference is retained.
- `/goals attach <plan.md> [solo]`: reconnect an existing plan without rewriting its evidence. Confirm the previous supervisor stopped, or all other writers stopped for solo. A `- worker session:` note supplies a resume reference.
- `/goals exit` during planning preserves the draft without approving implementation. Reattach it later rather than starting over.
- `/schedule-prompt`: view, add, toggle or remove scheduled jobs. Edit prompt/interval through `schedule_prompt update`. Binding is visible in `.pi/schedule-prompts.json`; tool text alone does not expose it.
- Plan requirements/manual ticks trigger review through a directory event hook. Task/evidence/Log maintenance does not. Eight unchanged working turns trigger a context-only upkeep reminder, not another timer.

## Known dependency limits

- **Stop workers before reloading the parent.** With stock edxeth, a worker can remain usable after parent `/reload`, then crash the parent when it later exits through a stale widget callback. This is reproduced, not fixed here. Recover with `pi --session <saved-parent.jsonl>`; retain the plan, inspect workers and explicitly reattach or choose solo. Saved-session restart followed by solo completion was tested.
- The installed scheduler deletes disabled jobs on shutdown/reload. Do not promise a disabled job will remain available to re-enable. Never run broad `cleanup` for goal housekeeping; remove only the owned job by ID. Existing job edits are otherwise retained by the prompts.
- Worker stop confirmation and scheduler actions use human judgment/model tools, not a cross-process locking framework. No automatic crash restart or exactly-once execution is claimed.

## Isolated validation

Run `node prototype/prepare.mjs <clean-pinned-edxeth-checkout> <installed-pi-package-root>`. It creates a temporary Git project and private profile, retains unrelated packages and substitutes only goals/subagent implementations. Start its printed script in a new no-focus Herdr pane. Do not operate user panes. Auth copies and raw profiles are private; never commit them.

[Current functional evidence](../slop/reviews/20260910_package-supervision-herdr.md) includes model/byte checks, Intercom draft tests, timer updates, the delayed reload crash and saved-session solo recovery. Automated tests do not replace these checks.

— Pi/OpenAI
