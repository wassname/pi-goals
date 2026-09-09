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
- Run the full normal Pi profile and package set in two real interactive sessions, visible beside each other in Herdr. Keep extensions, skills, prompt templates, themes, configuration and authentication. Do not silently launch a reduced profile with `--no-extensions`; honor deliberate worker resource choices. Supervisor mode changes the role/model and enforces its inspection-only policy, not a separately assembled installation. Fork the main planning session, activate supervisor mode and compact the fork.
- The supervisor retains the compacted planning session. Its repeated review loop reminds it that it is the supervisor and supplies the current canonical plan. Keep those directly available rather than relying on the compaction summary alone.
- Load Intercom once per Pi process. Do not add a second copy or extra standalone supervisor package when activating supervisor mode.
- The worker carries implementation detail. The supervisor gets incremental high-level views and retains its judgments, user intent and decisions.
- Remember the last model selected separately for planning, working and supervising.
- Ask material unresolved alignment questions, not a fixed quota. Inspect technical facts yourself; do not ask for confirmation of ordinary implementation details or repeat answered questions. Batch high-impact questions with context and a recommendation. An explicit current-plan request to skip optional questions applies only to that plan; it does not grant missing permission.
- Discuss returns the review menu to normal chat, preserving the draft. Do not immediately reopen the menu while the conversation is unfinished. Ready is the human's approval to start work.
- Live supervision must not use headless Pi RPC mode or a bespoke plan-lifecycle RPC layer. Use the real sessions and Intercom messages for views, steering and plan-bound approval checkpoints.
- Keep the design simple and reliable. The user reports that it is constantly breaking; adding more orchestration or approval forms is not progress. Preserve working components and remove unnecessary layers.
- Show useful supervisor assessments, advice and perspective, not only hidden tool arguments or delivery receipts. Keep the assessment brief. The supervisor's job is judgment and helping the worker stay on course, not filling forms; transport and approval bookkeeping are supporting details.
- After the initial fork compaction, compact the supervisor again above 100k current-context tokens (not cumulative usage), respecting the model's context limit. This is the latest user clarification of the earlier approximate 150k preference. Token/cost savings and the usefulness of advice need a real task trial; passing protocol tests alone does not establish either.

- Supervise autonomously until the agreed result is achieved and inspected. Investigate claims of being blocked, waiting, unable to proceed, or done; change ineffective steering, and keep authorized independent work moving. Respect genuine dependencies, explicit human pauses, scope and permission limits. Do not make the human drive routine progress.
- Keep supervision instructions generic and outcome-focused. Approval bookkeeping supports delivery; it is not the deliverable. Inspect actual artifacts and execution evidence, not just summaries, checked boxes, or test counts. Manual completion checkboxes are claims until CompleteGoal records sign-off. Accepted inconclusive remains explicitly uncertain under fail-forward policy.
- Git status is a review guideline, not a hard acceptance gate. Unrelated dirty files and ignored output directories can be legitimate. Do not force cleanup, commits, or a dirty-state fingerprint framework.

These are user preferences, not a claim that the current implementation satisfies every point.
Validate them in real panes as well as automated tests; record remaining gaps and actual per-role usage.

## Tests

Run `npm test` before a commit. It includes unit and flow tests plus the RPC review test.

For an explicitly approved trusted-package update, a command-scoped npm release-age exception is allowed. Keep the default policy intact; do not turn a targeted update into a general package upgrade. The user approved pi-subagents 0.66.0 on 2026-09-09.

- `test/*.test.ts` unit and flow tests use a small Pi API mock. They check plan state, tool gates, and plan-file updates.
- `npm run test:rpc` runs `test/rpc-review.test.ts`. It starts the installed Pi executable in RPC mode, uses Pi's real `select` protocol and conversational Discuss flow, and uses a local deterministic HTTP model. It does not need a credential or spend API credits. This is the closest automated session test.
- Use tmux for visual TUI debugging when the RPC test fails or a terminal-only problem is reported:

  ```bash
  tmux new-session -s pi-goals-debug 'cd /path/to/pi-goals && pi -e .'
  ```

  Run `/goals <objective>` in that pane. Tmux checks the rendered menu, editor focus, widget, and keyboard handling. RPC does not render the terminal UI.
- `pi -p` has no UI, so it cannot test `Ready`, `Discuss`, `Edit`, or `Cancel`.

- `npm run test:supervisor` runs the inherited `node:test` supervisor regressions. `npm test` also includes the always-enabled packed-artifact Intercom flow; Linux requires Unix-socket support.

## Functional acceptance: real isolated Herdr workflow

Pi/OpenAI procedure, requested by wassname; adapted from `8953dce`. Automated tests do not replace this check.

1. Read `herdr --skill` and confirm `HERDR_ENV=1`. Create a separate test pane with `--no-focus` and an isolated temporary Git repo. Never operate the user's existing worker or supervisor panes. Record the code revision and uncommitted changes being tested. Use a packed test package without replacing the active installation.
2. Start real interactive Pi with that package and available, different worker and supervisor models. Test the full normal profile on both sides, not two equally stripped profiles. Isolate only the candidate pi-goals package selection; do not load both old and candidate copies. Keep global settings untouched; if temporary non-secret role preferences must change, save and restore all three with guarded cleanup.
3. Use `/goals` for a trivial, bounded two-goal task: two exact-content files plus saved byte-verification output, with an ignored output directory and an unrelated dirty file to preserve. No GPU, dependencies or unrelated work. Read the planning conversation, verify that questions are material, inspect the draft, exercise ordinary-chat Discuss, and select Ready through the actual UI.
4. Confirm Ready opens a visible supervisor pane and the worker starts. Read both panes. Verify exact supervisor advice is visible, reaches the worker, and helps progress. Delivery receipts alone are not proof. Let the same pair stay active between both goals.
5. Let the worker produce artifacts and real verification output, then complete both CompleteGoal calls (retained supervisor `review_goal`, followed by the fresh evidence judge). Do not perform the worker's task. Record each manual nudge or repair as an intervention, not autonomous success. Conclusive and accepted-inconclusive results are not equivalent.
6. Inspect the actual artifacts and saved execution evidence, final plan, and both sessions. Handwritten output or a manual tick does not prove execution. Success means the requested results and both observed sign-offs, not tests passing or messages exchanged. Verify no commit/cleanup was forced for ignored outputs or unrelated dirt.
7. Exercise worker-only, supervisor-only and both-side reloads; fresh-shell resume without special launcher environment; drafting/Discuss; Ready/startup compaction; pending completion; and a stopped pairing. Preserve the plan, role, restrictions and peer identity. Interrupted decisions must fail visibly and allow retry, not approve stale work or create duplicate panes. Planning reload must not become approval or get permanently stuck. Record any recovery action needed and commands actually available.
8. If a stage fails, read both panes and the exact error before diagnosing it. Fix the cause, reload only the test instance, and retry that stage. After a prompt change use a fresh task. Repeated status checks are not a repair; wait-output timeouts/matches only signal that the pane needs inspection.
9. Save pane captures, session/artifact/log paths, revision, interventions, remaining failures, and separate role usage under `docs/slop/reviews/`. Assess usefulness and actual token/cost use, not a test-count substitute. Only close panes you created. Do not release, merge, or replace the user's installation as part of acceptance.
