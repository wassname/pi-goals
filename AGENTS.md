# pi-goals contributor notes

## User intent for supervision

The following preferences are the user's words, recorded on
[`experiment/goals-owned-supervision`](https://github.com/wassname/pi-goals/blob/06794bf/AGENTS.md#user-intent-for-this-branch):

> To be clear, the hope is we can have a smart supervisor like you, with judgment and context. But it doesn't use many tokens as it checks in and sees an overview.
>
> It steers a smaller model, adding perspective and judgment.
>
> It compacts every 150k or similar to avoid cost and context rot.
>
> It has a goal / plan on a Ralph-loop-type repeat.
>
> That lets the worker be a cheaper model, and the supervisor more expensive, and still get a good outcome.
>
> Oh, and since it's two panes, the user can review both!
>
> Well, I want to see what the supervisor is thinking and saying. That's the whole point: all supervisor thinking and messages should be visible.
>
> So that should make it obvious that I need to see the messages, and the supervisor needs to use judgment. For example, it could say how we are tracking or whatever every time, and it would be useful, like in the recap.
>
> And it would only be a few output tokens.

— wassname; spelling and punctuation corrected in the source by Pi/OpenAI.

## Confirmed product preferences

- One installable pi-goals package, not separately configured supervisor packages.
- Run the same Pi profile and package set in two real interactive sessions, visible beside each other in Herdr. Supervisor mode is a role, not a separately assembled profile or installation. Fork the main planning session, activate supervisor mode and compact the fork.
- The supervisor retains the compacted planning session. Its repeated review loop reminds it that it is the supervisor and supplies the current canonical plan. Keep those directly available rather than relying on the compaction summary alone.
- Load Intercom once per Pi process. Do not add a second copy or extra standalone supervisor package when activating supervisor mode.
- The worker carries implementation detail. The supervisor gets incremental high-level views and retains its judgments, user intent and decisions.
- Remember the last model selected separately for planning, working and supervising.
- Default to at least three task-specific alignment questions before the final plan. An explicit current-plan request to skip questions waives that round, not future plans.
- Discuss returns the review menu to normal chat, preserving the draft. Do not immediately reopen the menu while the conversation is unfinished. Ready is the human's approval to start work.
- Live supervision must not use headless Pi RPC mode or a bespoke plan-lifecycle RPC layer. Use the real sessions and Intercom messages for views, steering and plan-bound approval checkpoints.
- Keep the design simple and reliable. The user reports that it is constantly breaking; adding more orchestration or approval forms is not progress. Preserve working components and remove unnecessary layers.
- Show useful supervisor assessments, advice and perspective, not only hidden tool arguments or delivery receipts. Keep the assessment brief. The supervisor's job is judgment and helping the worker stay on course, not filling forms; transport and approval bookkeeping are supporting details.
- After the initial fork compaction, compact the supervisor again above 100k current-context tokens (not cumulative usage), respecting the model's context limit. This is the latest user clarification of the earlier approximate 150k preference. Token/cost savings and the usefulness of advice need a real task trial; passing protocol tests alone does not establish either.

These are user preferences, not a claim that the current implementation satisfies every point.
Validate them in real panes as well as automated tests; record remaining gaps and actual per-role usage.

## Tests

Run `npm test` before a commit. It includes unit and flow tests plus the RPC review test.

- `test/*.test.ts` unit and flow tests use a small Pi API mock. They check plan state, tool gates, and plan-file updates.
- `npm run test:rpc` runs `test/rpc-review.test.ts`. It starts the installed Pi executable in RPC mode, uses Pi's real `select` protocol and conversational Discuss flow, and uses a local deterministic HTTP model. It does not need a credential or spend API credits. This is the closest automated session test.
- Use tmux for visual TUI debugging when the RPC test fails or a terminal-only problem is reported:

  ```bash
  tmux new-session -s pi-goals-debug 'cd /path/to/pi-goals && pi -e .'
  ```

  Run `/goals <objective>` in that pane. Tmux checks the rendered menu, editor focus, widget, and keyboard handling. RPC does not render the terminal UI.
- `pi -p` has no UI, so it cannot test `Ready`, `Discuss`, `Edit`, or `Cancel`.

- `npm run test:supervisor` runs the inherited `node:test` supervisor regressions. `npm test` also includes the always-enabled packed-artifact Intercom flow; Linux requires Unix-socket support.
