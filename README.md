# pi-goals

Plan mode for agreeing on goals before any code gets written. Each goal names the subtle failure
mode that could fake a "done" and the discriminator that tells real success from it. Everything
lives in one markdown file, `.pi/plan.md`, which the agent edits with its normal edit tool and which
is injected verbatim every turn so it survives compaction. A goal is signed off only after a fresh
read-only judge checks its evidence against the repo.

Design bet (v2): the plan file is for LLMs and the human, not for TypeScript. There is no parser and
no schema. The format is a convention taught by a prompt; the judge, being a model, reads the file
natively, finds the claimed goal itself (wording drift is fine), runs the goal's `verify` command
itself, and validates the evidence in words. This deleted ~800 lines of v1 (parser, exact-string
goal matching, verify runner, JSON-stream judge transport, review menus) and with them the footguns
they caused.

Like [pi-milestones](https://github.com/Neuron-Mr-White/UniPi/tree/main/packages/milestone) and
[burneikis/pi-plan](https://github.com/burneikis/pi-plan), it guides rather than guards.
[pi-lgtm](https://github.com/wassname/pi-lgtm) was my earlier, more complex attempt.

## Install

Not yet published to npm; run from a checkout:

```bash
git clone https://github.com/wassname/pi-plan && cd pi-plan && npm install
pi -e ./src/index.ts
```

## Use

```
/goals CSV export for the report view
```

`/goals` enters plan mode and starts a conversation; the objective is an optional seed. From there:

1. Plan. The agent explores read-only (edit/write are blocked except on the plan file itself), asks
   about anything unclear, and drafts the goals into `.pi/plan.md`.
2. Review. Read the file; a two-option prompt asks Ready or keep planning. To revise, just reply.
3. Work. Each turn the whole plan file is injected (byte-identical when unchanged, so the KV cache
   holds), plus a reminder when the file went untouched for a turn. The agent ticks subtasks,
   appends to `## Log`, fills `evidence:`, and calls `CompleteGoal` when a discriminator is
   satisfied.

Other commands: `/goals clear` empties the plan file; `/goals judge <model-ref>` picks a specific
model for the sign-off judge (default: your current session model, else pi's default).

Coming from v1: a leftover `.pi/goals.md` is renamed to `.pi/plan.md` on session start.

## The plan.md format (a convention, not a schema)

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

## Log
- 2026-06-15 14:02  cache client wired; eviction next
```

- A goal is a checkbox line beginning `goal:` (`[ ]` open, `[/]` active, `[x]` done, `[-]`
  cancelled). That one line pattern is the only thing the extension itself reads (widget counts,
  reminder cadence, the Ready prompt); everything else in the file is prose to the extension.
- The `discriminator` is the success test, written while planning: the positive observation that the
  goal succeeded and that none of the `subtle failure mode`s could fake. `evidence` is the proof,
  filled at sign-off: each item pairs a durable artifact with a short read of it. Prefer committed
  artifacts (files, tests, diffs); `.pi/` is usually gitignored, so evidence there is judge-time
  proof only and won't survive in history.
- Small format deviations are fine; the file is read by the human and the judge, not a parser.
- The agent prunes finished goals itself when the file gets long (evidence survives in git history
  and `## Log`).

## Signing off a goal (`CompleteGoal`)

`CompleteGoal(goal)` is the one blessed tool. It spawns a strictly read-only `pi` subprocess (`-p
--no-session --no-extensions`, tools `read,grep,find,ls` -- no bash, no edit/write) with the whole
plan file and the claimed goal. The judge cannot execute anything, so it never re-runs your verify
command (which may be a 10-hour training job); the agent runs `verify` itself and saves the output
as evidence. The judge reviews evidence discipline in order -- anything here at all? each item
quoted and attributed? provenance visible (how was this produced)? do the quotes match the cited
files on disk? -- and only then the substance, returning `VERDICT: accept | reject` plus what's
missing. It reads the live working tree, not HEAD: uncommitted work counts, and committing before
sign-off is for durable evidence, not for the judge's visibility.

- accept: a sign-off line is appended to `## Log` and the goal is ticked `[x]` in the same write
  (exact goal-line match only; on wording drift the result asks the agent to tick it). The
  tool-written log line is the audit trail; a hand-tick without one shows in the diff.
- every run saves the judge's full transcript to `.pi/judge/<stamp>.md`, referenced from the log
  line, so "what did the judge actually check?" stays answerable after the fact.
- reject: the goal stays open and the agent gets the missing list.
- judge ran but failed/errored/timed out, or returned no VERDICT line: accepted inconclusive,
  logged as such. There is no pre-emptive "no model" path -- a null judgeModel just omits
  `--model` so pi's configured default runs the judge, so inconclusive always means "ran but
  failed", never "couldn't start". The working agent is never blocked on judge infra.

## Prompts

All model-facing text lives in [`src/prompts.ts`](src/prompts.ts), in flow order.

## Develop

```bash
pi -e ./src/index.ts        # load locally
npm test                    # vitest: judge argv invariants, appendLog, decideSignOff fail-forward
npm run typecheck
npm run lint
```

## License

MIT
