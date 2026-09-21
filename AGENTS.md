# pi-goals contributor notes

## Design

The main chat discusses the plan with the user, then supervises an interactive `goals-worker` in Herdr. Use stock pi-subagents, pi-intercom and @jl1990/pi-scheduler; do not build another transport, scheduler or worker runtime.

> the hope is we can have a smart supervisor like you, with judgment and context. But it doesn't use many tokens as it checks in and sees an overview.
>
> It steers a smaller model, adding perspective and judgment.
>
> Well, I want to see what the supervisor is thinking and saying. That's the whole point: all supervisor thinking and messages should be visible.

— wassname

The supervisor should:
- Be on a Ralph loop of goals.
- Keep perspective and context, be token-efficient, and use a more expensive model than the workers.
- Check in on subagents every N minutes (editable; default hourly).
- Review subagent work and steer towards the goal:
  - If a subagent stops for any reason, including saying it's blocked or done.
  - If a subagent tries to change the plan, including ticking things off.
- Let the human see and intervene in both worker and supervisor as native Pi panels in Herdr. We keep workers open so the human can check their outputs and final review, usually in the final or penultimate message.

- Keep supervisor inspection tools. It inspects actual results, delegates implementation and must not weaken the user's goal to accept worker output.
- The supervisor is normally the highest-capability model: it owns high-level diagnosis, research interpretation, experimental design and consequential judgment; workers do bounded execution, evidence gathering and independent criticism. — wassname
- Keep `worker_view` as compact VCC Markdown: summarize current process/subagent presence, do not dump transcripts, raw JSON or repeated compaction, and request detail only when needed. — wassname (Pi wording/spelling edits)
- Put all model-facing prompts in `src/prompts.ts`, in conversation order. Preserve the user's verbatim requirements.
- `/goals` opens actions. New plan starts a discussion without an objective form. Unknown commands never start planning. Start with an explicit provisional draft, then explore and grill consequential gaps; redraft freely and honor requested shortcuts/order. Only intentional RequestPlanReview or human review opens acceptance; saves/interviews never do. Ready remains human execution authorization.
- Keep goal titles/status in widgets; omit subtask text. Tasks and evidence remain in the plan.
- Keep startup/compaction plan context, short upkeep reminders and visible check-ins. Record task/evidence bookkeeping passively; wake the supervisor only for changed requirements or goal status. — wassname (Pi wording)
- A secret-display restriction does not block an authorized credential-backed command: use the project's existing loader without exposing values, and ask the human only when authorization, the credential or execution permission is absent. — wassname (Pi wording)
- Keep recoverable solo mode: confirm other writers stopped before taking over. Solo completion is self-verification.
- Record distinct runtime ID, Intercom ID and saved-session path with provenance. A handle or delivery receipt is not proof of liveness or action. User model changes are authorized; do not silently restore an old preference.

## Waiting and check-in judgment

- Followed long job: let it run, verify follow-up and check less often.
- Unfollowed job: arrange coverage through existing controls; do not assume a wake.
- Owned subagent still running: inspect through its owner; an ended worker turn is not completion.
- Later wake: inspect new results/failure and continue or steer without replaying completed work.

Reassess cadence by editing the existing owned check-in: slower for reliable long waits, faster when steering is needed. Consider a more capable worker within user model/budget preferences. Preserve custom prompts and foreign jobs; do not add timers.

— wassname's guidance; Pi wording and spelling edits.

## Tests

Run `npm test`, `npm run typecheck` and `npm run lint` before committing.

`test/rpc-review.test.ts` runs a deterministic parent/worker story using real Pi, saved sessions and stock Intercom: planning/Ready, failure after progress, offline recovery, sourced review, delivery retry, same-worker correction, reload, intentional interruption and busy Clear. The RPC fixture seeds the launch binding rather than calling OpenGoalWorker. It does not prove native pane allocation/rendering or model judgment. `test/goals.test.ts` retains focused file-mutation, ownership and lifecycle checks that are cheaper to exercise at the Pi API boundary. Run targeted tests through `npm test -- <file>` so ignored investigations stay outside discovery. <!-- Pi/OpenAI -->

For functional acceptance, read `herdr --skill`, confirm `HERDR_ENV=1`, and use `scripts/prepare-trial.mjs` to create an isolated project/profile. Open only new no-focus test panes. Observe the actual planning dialogue and Ready selection, worker attachment, Intercom report, independent artifact inspection and CompleteGoal. Record interventions separately from autonomous success. Preserve nonempty byte/test evidence. Never reload or operate active user research panes. Close test panes when finished.

Stop workers before reloading legacy supervisor/test sessions: later worker exit can crash their stale context. Legacy pi-schedule-prompt sessions may delete disabled jobs on reload/shutdown; the bundled @jl1990/pi-scheduler 0.5.0 retains disabled tasks. Test saved-session/solo recovery without repeating completed work; do not claim legacy package bugs are fixed here.

Keep temporary plans, audits and captures under ignored `.local/`. Git history retains the removed historical material. Do not add root handovers or duplicate READMEs. Never touch human-named files or credentials.

Branch instructions consolidated by Pi/OpenAI from wassname's preferences.
