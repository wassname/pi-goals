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

## Intended supervision workflow

I already have pi-intercom-supervisor, but thought using pi-subagents could make it simpler. The idea is that the user makes a plan as in pi-goals, but on this branch, instead of a naive stateless subagent, we 1) fork, 2) compact, and 3) make it a supervisor with a prompt as in pi-intercom-supervisor. The supervisor is cheap because it sees only high-level material, which costs fewer tokens. It has good judgement because it sees a) compacted planning context, b) the plan, and c) summarised context (for example, my modified pi-vcc). This lets it operate read-only and steer the worker without losing track. It also compacts every 100k tokens to keep it cheap and high-level.

I am now thinking the subagent implementation may be too difficult. To keep the plan and forking, this branch of pi-goals could make another Pi session, perhaps using the fork explicitly, and use pi-intercom or pi-messenger to communicate with it. The user can switch to it, or Herdr could open it automatically.

-- wassname
