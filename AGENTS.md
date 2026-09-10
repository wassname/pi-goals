# pi-goals contributor notes

## Design

The main chat discusses the plan with the user, then supervises an interactive `goals-worker` in Herdr. Use stock pi-subagents, pi-intercom and pi-schedule-prompt; do not build another transport, scheduler or worker runtime.

> the hope is we can have a smart supervisor like you, with judgment and context. But it doesn't use many tokens as it checks in and sees an overview.
>
> It steers a smaller model, adding perspective and judgment.
>
> Well, I want to see what the supervisor is thinking and saying. That's the whole point: all supervisor thinking and messages should be visible.

— wassname

- Keep supervisor inspection tools. It inspects actual results, delegates implementation and must not weaken the user's goal to accept worker output.
- Put all model-facing prompts in `src/prompts.ts`, in conversation order. Preserve the user's verbatim requirements.
- `/goals` opens actions. New plan starts a discussion without an objective form. Unknown commands never start planning. A changed settled draft opens the approval dialogue; unchanged discussion does not repeatedly reopen it.
- Keep goal titles/status in widgets; omit subtask text. Tasks and evidence remain in the plan.
- Keep startup/compaction plan context, short upkeep reminders and visible editable hourly check-ins. Avoid unchanged-plan repetition and identity-only review turns.
- Keep recoverable solo mode: confirm other writers stopped before taking over. Solo completion is self-verification.
- Record distinct runtime ID, Intercom ID and saved-session path with provenance. A handle or delivery receipt is not proof of liveness or action. User model changes are authorized; do not silently restore an old preference.

## Tests

Run `npm test`, `npm run typecheck` and `npm run lint` before committing.

`test/goals.test.ts` exercises current state, file updates and role restrictions with a Pi API mock. `test/rpc-review.test.ts` starts real Pi with a deterministic local model and schema-only worker tools: it checks automatic proposal, editor/discussion and Ready role transition without credits or launching workers. It does not prove Herdr rendering, live message delivery or model judgment.

For functional acceptance, read `herdr --skill`, confirm `HERDR_ENV=1`, and use `scripts/prepare-trial.mjs` to create an isolated project/profile. Open only new no-focus test panes. Observe the actual planning dialogue and Ready selection, worker attachment, Intercom report, independent artifact inspection and CompleteGoal. Record interventions separately from autonomous success. Preserve nonempty byte/test evidence. Never reload or operate active user research panes. Close test panes when finished.

Known stock limits: stop workers before supervisor reload (later worker exit can crash its stale context); disabled scheduler jobs are deleted on reload/shutdown. Test saved-session/solo recovery without repeating completed work; do not claim these package bugs are fixed here.

Keep temporary plans, audits and captures under ignored `.local/`. Git history retains the removed historical material. Do not add root handovers or duplicate READMEs. Never touch human-named files or credentials.

Branch instructions consolidated by Pi/OpenAI from wassname's preferences.
