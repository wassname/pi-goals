# pi-goals

Plan mode for agreeing on goals before any code gets written. Each goal names the subtle failure mode
that could fake a "done" and the discriminator that tells real success from it, plus subtasks and the
evidence checked at sign-off. It lives in one markdown file. A widget keeps the goals in front of you
through compaction, a reminder nudges the agent to keep the file current, and a goal is signed off
only after a read-only subagent checks its evidence.

Like [pi-milestones](https://github.com/Neuron-Mr-White/UniPi/tree/main/packages/milestone) and
[burneikis/pi-plan](https://github.com/burneikis/pi-plan), it guides rather than guards: a form and a
process the agent follows. [pi-lgtm](https://github.com/wassname/pi-lgtm) was my earlier, more complex
attempt.

## Install

```bash
pi install npm:@wassname2/pi-goals
```

Or run it without installing:

```bash
pi -e npm:@wassname2/pi-goals
```

## Use

```
/goals CSV export for the report view
```

`/goals` enters plan mode and starts a conversation; the description is an optional seed, so plain
`/goals` works too. From there:

1. Plan. The agent explores read-only, asks about anything unclear, and writes the goals into
   `.pi/goals.md`.
2. Review. You get a menu: Ready, Edit (ask the agent to revise), Open in `$EDITOR`, or Cancel. On
   Ready you choose whether to keep the current context or start fresh and compacted.
3. Work. Each turn the active goal is injected so it survives compaction, and a reminder nudges the
   agent to keep `goals.md` current and keep going. When a goal's discriminator is satisfied the agent
   calls `CompleteGoal`, which runs `verify` and a read-only judge, then marks the goal done and logs it.

Other commands: `/goals clear` empties `.pi/goals.md`; `/goals judge <model-ref>` picks a specific
model for the sign-off judge (the default is your current model).

## Example

```
/goals audit the papers dir metadata and clean up empty dirs
```

The agent explores read-only, drafts the goal with a subtle failure mode and the discriminator that
beats it, and stops for review:

```markdown
## Goals

1. [ ] goal: Audit steering/ metadata and remove empty dirs
  - subtle failure mode: report written but counts are zero (resolver errored silently)
  - discriminator: report shows the XXXX count before/after AND a non-zero rename count
  - tasks:
    1. [ ] dry-run the metadata resolve
    2. [ ] remove the empty _artifacts dirs
    3. [ ] write the report
  - evidence:
    - <empty until sign-off>
```

You choose Ready. The agent works the subtasks, fills `evidence` (each item an artifact plus a short
read of it), and calls `CompleteGoal`:

```markdown
  - evidence:
    - > scripts/metadata_report.txt: XXXX 52 -> 4, 146 empty _artifacts removed
    - > 48 files renamed; almost certain done, the silent-resolver failure mode is ruled out
```

A fresh read-only subagent re-checks the evidence against the repo and the discriminator, then
returns its verdict and reasoning:

```
Signed off "Audit steering/ metadata and remove empty dirs". Marked done in goals.md.

--- sign-off judge ---
metadata_report.txt present; counts 52 -> 4 confirmed; rename log shows 48 renamed (not zero).
VERDICT: accept
```

## The goals.md format

One project-local file, `<cwd>/.pi/goals.md` (gitignored), holds the title, a context block, the
goals, and a short append-only log. A fresh `/goals` draft replaces it.

```markdown
# ship the cache layer

Latency target came from the SLO review; keep the existing client API.

## Goals

1. [/] goal: Implement cache layer
  - subtle failure mode: cache silently bypassed, latency ok by luck
  - discriminator: hit-rate > 0.8 in load-test.log (a bypass reads ~0)
  - verify: pytest tests/cache -q && python bench/p95.py --max-ms 50
  - tasks:
    1. [x] wire cache client
    2. [/] eviction policy
  - evidence:
    - > load-test.log: p95=41ms, hit-rate 0.93 (not bypassed)

# Future work / out of scope

- distributed cache

## Log
- 2026-06-15 14:02  cache client wired; eviction next
```

- A goal is a numbered checkbox line beginning `goal:`; the checkbox carries its state (`[ ]` open,
  `[/]` active, `[x]` done, `[-]` cancelled). Goals are matched by their text, so the number is just
  for you to reference.
- The `discriminator` is the success test, written while planning: the positive observation that the
  goal succeeded and that none of the `subtle failure mode`s could fake (a count moved, a test
  exercised the path, a metric beat noise), not just that a failure was avoided. `evidence` is the
  proof, filled at sign-off: each item pairs a durable artifact (a quoted and linked log, a table, a
  metric) with a short read of it. `verify`, when present, is the deterministic first stage.
- Subtasks are any checkbox without a `goal:` prefix, under `- tasks:`. The agent ticks them, appends
  to `## Log`, and sets a goal `[/]` when it starts it; only `CompleteGoal` writes `[x]`. Several
  goals can be active at once.

## Signing off a goal (`CompleteGoal`)

`CompleteGoal(goal)` (matched by the goal's text) is the only tool that marks a goal done; everything
else is the agent editing the file. It reads the goal's `evidence:` block from `.pi/goals.md`, then:

1. If the goal has a `verify:` command, it runs. A non-zero exit rejects right away, no model call.
2. Then a read-only `pi` subprocess (a fresh `--no-session` context, so it never sees the working
   agent's transcript) inspects the `evidence:` against the repo, the `discriminator`, and the
   `subtle failure mode`. It re-derives from the cited artifacts rather than trusting the claim, so
   list real artifacts, not assertions.
3. On accept, the goal flips to `[x]` and a `## Log` line is written. On judge reject, it stays open
   and the agent is told what is missing. If the judge subprocess times out or its transport/model
   fails after any `verify:` command has passed, the goal still flips to `[x]` with a `judge
   inconclusive` log line and any partial judge output in the result. Either way the judge's
   reasoning comes back in the result.

The judge defaults to Pi's default model unless `/goals judge <provider/model>` is set. Point it at
another model for an independent cross-family check.

## Prompts

All model-facing text lives in [`src/prompts.ts`](src/prompts.ts), in flow order, so you can read the
whole process top to bottom.

## Develop

```bash
pi -e ./src/index.ts        # load locally
npm test                    # vitest: parser + sign-off record logic
npm run typecheck
npm run lint
```

## Not (yet) included

- No autonomous re-prompt loop. The reminder nudges the agent within a turn, but the turn still ends
  and hands back to you; nothing auto-re-prompts until the goals are done.
- The plan and execution phases can't yet run on different, sticky models.

## License

MIT
