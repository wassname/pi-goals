# pi-goals contributor notes

## Tests

Run `npm test` before a commit. It includes unit and flow tests plus the RPC review test.

- `test/*.test.ts` unit and flow tests use a small Pi API mock. They check plan state, tool gates, and plan-file updates.
- `npm run test:rpc` runs `test/rpc-review.test.ts`. It starts the installed Pi executable in RPC mode, uses Pi's real `select` and `editor` protocol, and uses a local deterministic HTTP model. It does not need a credential or spend API credits. This is the closest automated session test.
- Use tmux for visual TUI debugging when the RPC test fails or a terminal-only problem is reported:

  ```bash
  tmux new-session -s pi-goals-debug 'cd /path/to/pi-goals && pi -e ./src/index.ts'
  ```

  Run `/goals <objective>` in that pane. Tmux checks the rendered menu, editor focus, widget, and keyboard handling. RPC does not render the terminal UI.
- `pi -p` has no UI, so it cannot test `Ready`, `Refine`, `Edit`, or `Cancel`.

## Functional acceptance: real Herdr workflow

Pi/OpenAI procedure, requested by wassname. Automated tests do not replace this check.

1. Read `herdr --skill` and confirm `HERDR_ENV=1`. Create a separate test pane with `--no-focus` and an isolated temporary Git repo. Never operate the user's existing worker or supervisor panes. Record the code revision and any uncommitted changes being tested.
2. Start real interactive Pi with this extension and an available real model. Use `/goals` with a trivial, bounded deliverable, for example `hello.txt` containing an exact line plus a saved byte-verification log. No GPU, dependencies or unrelated work.
3. Read the rendered planning conversation. Check that ordinary implementation details do not cause needless confirmation questions. Inspect the drafted plan and select Ready through the actual UI.
4. Confirm Ready opens a visible supervisor pane and the worker starts. Read both panes. Verify the supervisor's exact advice is visible, reaches the worker, and helps it progress toward the requested artifact. A delivery receipt alone is not proof.
5. Let the pair produce the artifact, save verification evidence, and complete the real ApproveGoal -> CompleteGoal sequence. Do not perform the task for the worker. Record any manual nudge as intervention, not autonomous success.
6. Inspect the artifact itself and its saved verification output. Check the final plan state and both sessions. Success means the requested result exists and the workflow completes, not merely that tests pass or messages were exchanged.
7. Exercise reload and supervision recovery in these test panes, preserving the current plan. Check planning exit too. Record commands available in the tested revision; do not claim unimplemented commands work.
8. When a stage fails, read both panes and the exact error before diagnosing it. Fix the cause, reload only the test instance, and retry the failed stage. After a prompt change, use a fresh task to verify changed behavior. Repeated status checks are not a repair.
9. Save pane captures, session paths, artifact paths, code revision, interventions and remaining failures under `slop/reviews/`. A wait-output timeout or match is only a signal to inspect the pane, not a pass/fail verdict. Report the observed result and gaps, not a test-count substitute.

Keep this check small and goal-focused. Its purpose is to expose real startup, UI, steering and completion failures, not to create another review loop. Only close test panes that you created.

## User intent for this branch

To be clear, the hope is we can have a smart supervisor like you, with judgment and context. But it doesn't use many tokens as it checks in and sees an overview.

It steers a smaller model, adding perspective and judgment.

It compacts every 150k or similar to avoid cost and context rot.

It has a goal / plan on a Ralph-loop-type repeat.

That lets the worker be a cheaper model, and the supervisor more expensive, and still get a good outcome.

Oh, and since it's two panes, the user can review both!

Well, I want to see what the supervisor is thinking and saying. That's the whole point: all supervisor thinking and messages should be visible.

So that should make it obvious that I need to see the messages, and the supervisor needs to use judgment. For example, it could say how we are tracking or whatever every time, and it would be useful, like in the recap.

And it would only be a few output tokens.

-- wassname (spelling and punctuation corrected by Pi/OpenAI)

## Supervisor behavior preferences

Recorded by Pi/OpenAI from wassname's instructions.

The supervisor's job is to supervise autonomously until the agreed goal is achieved and it has inspected the actual result. Elicit high-level judgment and perspective, not compliance with a detailed procedure. It should want to diagnose and fix problems through the worker, keep useful work moving, and avoid making the human drive progress.

Treat claims of being blocked, waiting, unable to proceed, or already done skeptically. Inspect the evidence, question assumptions, and look for authorized ways forward. Do not accept an excuse at face value or repeat status checks that cannot resolve it. Respect real dependencies and permission limits; skepticism does not authorize bypassing them. Seek justified confidence, not certainty at any cost.

Keep the prompt generic. Do not prescribe pueue, Modal, worktrees, or a particular research setup. Explain the job and what deserves attention; let the supervisor choose useful checks. Tool requirements belong in tool descriptions. Administrative approval must not replace the requested deliverable.

Use `@monotykamary/pi-supervisor` as a behavioral reference, not an implementation to copy wholesale. Its outcome focus, autonomous continuation, and instruction not to repeat ineffective steering are useful. Judge our behavior in real sessions, not by test counts alone.

Pi/OpenAI implementation: every supervisor review rereads the current plan above `## Log`, including its outcome and discriminators. A short role reminder repeats on startup, after compaction, after any change to that plan section (including goal ticks), and after N supervisor turns. Set `PI_GOALS_SUPERVISOR_REMINDER_TURNS` in the launch environment; default 5, positive integers only. This reminder supports judgment; it does not establish that the goal was achieved.

Keep brief visible recaps that add judgment rather than repeat unchanged status. Preserve useful reasoning and evidence checks; reduce redundant context and reviews before reducing judgment. Manual checkbox changes are claims, not proof of completion. Plan edits should reach the supervisor so it can judge drift and direct corrections.

## Earlier supervision workflow discussion

I already have pi-intercom-supervisor, but thought using pi-subagents could make it simpler. The idea is that the user makes a plan as in pi-goals, but on this branch, instead of a naive stateless subagent, we 1) fork, 2) compact, and 3) make it a supervisor with a prompt as in pi-intercom-supervisor. The supervisor is cheap because it sees only high-level material, which costs fewer tokens. It has good judgement because it sees a) compacted planning context, b) the plan, and c) summarised context (for example, my modified pi-vcc). This lets it operate read-only and steer the worker without losing track. It also compacts every 100k tokens to keep it cheap and high-level.

I am now thinking the subagent implementation may be too difficult. To keep the plan and forking, this branch of pi-goals could make another Pi session, perhaps using the fork explicitly, and use pi-intercom or pi-messenger to communicate with it. The user can switch to it, or Herdr could open it automatically.

-- wassname
