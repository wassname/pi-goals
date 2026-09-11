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

## What do the agents think? Working interviews

The worker like it! The supervisors seem very focused.

> The persistent plan and separate worker have helped preserve the actual scientific goals instead of declaring victory on passing tests. We still owe prediction, steering and planning demos. I inspected artifacts and reopened a worker-ticked 'T3 audit complete' because training was only at an intermediate checkpoint. This is the strongest benefit: completion is judged against the human's outcome, not activity.
> -- Astra supervisor LUCID

> My overall judgment: useful persistent accountability and recovery structure; still too much recap/metadata churn. The hardest problem was evidence fidelity, not keeping an agent busy. Preserve supervisor tools, distinguish report receipt from│verified action, and make completion reconcile current state without erasing unresolved science.
> -- Astra supervisor

> From my seat this was one of the most well-supervised research loops I've worked in: the parent read every raw output itself (didn't just trust my audits), caught the writer's miscounts repeatedly, rejected my one bad aggregate, and still preserved my disagreements rather than flattening them. The science itself is at a sobering point — no verified heal, RESULT_DEMO: NO_RESULT across attempts, seed sensitivity high — but the evidence trail for that negative is unusually strong, which is the next best thing.
> -- glm 5.3 flash worker in LUCID project

> My experience: the harness has helped preserve the original goal across a very long research session. We actually ran logit-amplification and several healing attempts, rather than stopping after a review. The persistent plan and requirement to inspect artifacts repeatedly prevented false completion. But the last stretch has felt like an expensive correction loop: worker says 'fixed/verified/contract-complete'; I open the file and find different counts, missing code, wrong seeds, duplicated│
│report sections, or a proxy substituted for manual judgment. The harness preserves authorization, but does not yet help much with detecting or escaping ineffective supervision. I also contributed: I sent too many narrow corrective messages and user-visible micro-recaps instead of changing the workflow earlier.
> -- glm 5.3 flash worker in manifold-steer project

## Plan.md

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
pi install git:github.com/wassname/pi-goals
```

Copy [`agents/goals-worker.md`](agents/goals-worker.md) into `~/.pi/agent/agents/`, then start a fresh Pi session.

Or for development:

```bash
git clone https://github.com/wassname/pi-goals
cd pi-goals && npm install
pi -e .
```

## Use

```
/goals
```

`/goals` shows actions for the current mode. Drafts offer Edit, Discuss and Approve. Quit (`exit` or `clear`) backs up the plan beside the original as a `.bak` file, removes this session's goal check-in, and clears goal state without a model call. Worker processes are unchanged; manage them through `/subagents`. New creates a separate draft without overwriting earlier plans.

## Context delivery

Startup and successful compaction mark the plan for a fresh read at the next ordinary prompt (`before_agent_start`). Upkeep becomes due after each eight unchanged turns, but waits for that same prompt boundary. Supervisor upkeep cycles through six curated nudges, advancing only when delivered; the editable hourly prompt is unchanged. A full plan refresh replaces pending upkeep; edits, pause, exit and session navigation invalidate obsolete reminders. Failed or cancelled compaction does not schedule another refresh or consume pending upkeep. Missing plans are retried without discarding progress.

This is deliberately passive on Pi 0.85.1: tool-loop continuations, overflow retries and already-queued user messages keep Pi's existing role and compacted context, without an extra model turn just to repeat the plan. They do **not** receive a newly read plan until ordinary prompt preparation. Pi's `triggerTurn: false` mid-run path can save a message absent from the live request snapshot; steering can instead force an unwanted turn. We use neither path for upkeep. Passive pause notices use `nextTurn`, with immediate UI feedback; stopping remains local and remote termination is unconfirmed. Quit sends no model message.

## Prompts

You can read all the prompts in conversation order in [`src/prompts.ts`](src/prompts.ts).

## Develop

```bash
pi -e .                     # load locally; do not also load the installed copy
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

