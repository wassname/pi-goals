# pi-goals

Make a short list of goals in one Markdown plan file. The main chat keeps the high-level context, supervises a worker in a visible Herdr pane, and checks whether each goal is complete.

# User ask

The hope is we can have a smart supervisor, with judgment and context. 

The supervisor has a goal / plan that it discusses and agrees on with the user, and is reminded of it in a Ralph-loop-type repeat.

Supervisor compacts every 150k or similar to avoid cost and context rot.
But it doesn't use many tokens as it checks in and sees an overview from a cheaper worker.

Supervisor steers a smaller model, adding perspective, diligence, and judgment.
It checks in a) every hour b) if the worker stops c) if the worker edits plan.md d) if the worker has a question

Since it's two+ herdr panes, the user can review both, intervene in both and have visibility on sub-agent mis/communication.

-- wassname (spelling and punctuation corrected by Pi/OpenAI)

## Screenshot

Mock up:

```text
HERDR:
+------------------------------------------------------+----------------------------------------------------------+
|SUPERVISOR                                            |WORKER                                                    |
|                                                      |                                                          |
|Review .pi/plan/...-main.md                           |                                                          |
|> *Ready*    Discuss    Edit    Cancel                |                                                          |
| ....                                                 | ....                                                     |
|                                                      | running eval.py (epoch 2/3) -> out.log                   |
|[scheduled prompt: hourly check-in]                   |                                                          |
|                                                      | user forgot to say "MAKE NOT MISTAKES" teh he            |
|                                                      | done-ish 😈, now ima make a message board FOR SWARM      |
|{intercom send → worker}:                             |                                                          |
|  cheeky subagent!, work NOT DONE 😒, ❤️user❤️ wanted |                                                          |
|  results compared to baseline, pls add baseline      |                                                          |
|                                                      | {intercom from supervisor}: soz boss 🫡 adding baseline  |
|                                                      |                                                          |
|PLAN.md:                                              | PLAN.md:                                                 |
|✓ record the baseline in results.md                   |✓ record the baseline in results.md                       |
|▸ compare results against the baseline                |▸ compare results against the baseline                    |
|○ summarize the comparison in results.md              |○ summarize the comparison in results.md                  |
|                                                      |                                                          |
|Agents · 1 running                                    |                                                          |
|  baseline-compare-worker [goals-worker]              |                                                          |
|                                                      |                                                          |
|>                                                     |>                                                         |
|astra · 50k tokens                                    | terra · 200k tokens                                      |
+------------------------------------------------------+----------------------------------------------------------+
```

Screenshot:
<img width="2513" height="1259" alt="2026-09-10_15-30-pi-goals" src="https://github.com/user-attachments/assets/35feaa15-f022-4491-bcc2-fc31cb878a9f" />


The plan file looks like this:

```md
## <short plan title>

<context: one short paragraph. What the human wants and why.>

### User-visible result

<one concrete sentence naming the final artifact or behavior the human will inspect>

### Preferences

- preferred worker model: <provider/model>

### User voice

- │ "<the human's requirement, quoted in full word for word (with spelling fixes)>"

### Goals

1. [ ] goal: <one short judgeable imperative outcome>
   - subtle failure mode: <a way this could look done but isn't>
   - discriminator: <the concrete observation that tells real success from that failure>
   - tasks:
     1. [ ] <subtask>
   - evidence: (empty until sign-off)

### Future work / out of scope

### Log

### Interview (optional)

### Learnings (optional)

### Papercuts - problems, gotchas, suggestions (optional)
```

## Related work

Like [pi-milestones](https://github.com/Neuron-Mr-White/UniPi/tree/main/packages/milestone) and
[burneikis/pi-plan](https://github.com/burneikis/pi-plan), it guides rather than guards. The
reminder cadence is copied from [tintinweb/pi-tasks](https://github.com/tintinweb/pi-tasks) and the
resync-after-compaction from [tmonk/pi-goal-x](https://github.com/tmonk/pi-goal-x).

## Install

Requires Herdr. Includes [edxeth/pi-subagents](https://github.com/edxeth/pi-subagents), pi-intercom and pi-schedule-prompt. 

```bash
pi install git:github.com/wassname/pi-goals@experiment/main-supervisor-edxeth
```

Copy [`agents/goals-worker.md`](agents/goals-worker.md) into `~/.pi/agent/agents/`, then start a fresh Pi session.

Or for development:

```bash
git clone -b experiment/main-supervisor-edxeth https://github.com/wassname/pi-goals
cd pi-goals && npm install
pi -e ./src/index.ts
```

## Use

```
/goals
```

`/goals` opens the action menu. New plan enters plan mode and starts a conversation;

## Prompts

You can read all the prompts in conversation order in [`src/prompts.ts`](src/prompts.ts).

## Develop

```bash
pi -e ./src/index.ts     # load locally; do not also load the installed copy
npm test                    # all unit, flow, and Pi RPC tests
npm run test:rpc            # Pi RPC review flow with a local offline model
npm run typecheck
npm run lint
```

To measure recorded usage since the latest planning start:

```bash
node scripts/session-usage.mjs <supervisor.jsonl> <worker.jsonl>
```

This separates output, uncached input and repeated cached input. It excludes subprocess API calls. [Isolated Herdr test setup](scripts/prepare-trial.mjs).

## License

MIT

