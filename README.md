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

Requires Herdr. Includes [nicobailon/pi-subagents](https://github.com/nicobailon/pi-subagents) 0.66.0, pi-intercom and pi-schedule-prompt.

```bash
pi install git:github.com/wassname/pi-goals
```

Start a fresh Pi session. No worker agent file is needed: `OpenGoalWorker` uses Nico's public `project.open` surface, then the peer explicitly attaches with `AttachGoalPlan`. Use one pi-goals installation and disable separately installed copies of its bundled companions; duplicate scheduler instances send duplicate prompts.

The bundled pi-schedule-prompt 0.4.1 reads project schedules even when Pi project trust is declined. Until that upstream issue is fixed, use this bundle only in repositories you trust.

For development, register the checkout so workers also discover its extensions:

```bash
git clone https://github.com/wassname/pi-goals
cd pi-goals && npm install
pi install .
pi
```

## Use

```
/goals
```

`/goals` shows actions for the current mode. Drafts offer Edit, Discuss and Approve. Discuss returns to chat and waits for your input. Menu New asks for optional instructions before creating a plan; submit blank to use the conversation, or cancel to leave things unchanged. Typed `/goals new <instructions>` still starts directly. Quit (`exit` or `clear`) leaves the original plan unchanged, removes this session's goal check-in, and clears goal state without a model call. Matching check-in names with missing or different session bindings are left unchanged with a warning. Worker processes are unchanged; inspect their native panes and use their exact Intercom identities for steering. New creates a separate draft without overwriting earlier plans, named `.pi/plan/<last-six-session-characters>-vN.md` using the next version after existing files. The title stays inside the plan; old files are not renamed. The widget shows a plain `✓` and the relative plan path for inside-project plans. External plans use the filename with an `(external)` marker; `/goals status` keeps the full location. These are plain labels, not terminal links.

### Native worker lifecycle and limits

The parent and worker keep separate native conversations. Worker attachment and stop notices use stock Intercom extension channels; assignments, reports and corrections remain visible Pi messages. A pane-open receipt, idle state or delivery receipt does not approve a goal.

`OpenGoalWorker` opens a blank peer and waits for verified Intercom capability before sending work. For independent work after review, use `action: "fresh"` with the exact inspected `reviewedThrough` entry ID. This uses Pi's new session in the same pane; the previous conversation stays in saved history. Revisions still use the same Intercom session. Drafts, pending input, changed history and a local worker pause block replacement.

For recovery, use `action: "recover"`, `writersStopped: true` and the owned saved session after inspecting other writers. Recovery restores context without replaying a task or changing its model. A prospective session path is not durable history. A live binding without a responsive, capable Pi peer remains unconfirmed; no shell restart or second backend is invented.

Without an explicit model preference, a new context uses the current Pi profile's normal defaults. A session-local human choice remains in that earlier session's history; recovery retains it. Requested-model automation currently fails closed: Pi's asynchronous public setter lacks a guard against overwriting a concurrent human selection. No fallback task is launched and no stale preference is reapplied. This model-selection requirement remains unfinished. — Pi/OpenAI

## Context delivery

New injected `[pi-goals]` prompts display as a compact notice; `Ctrl+O` expands the full text. This changes only the display: the original prompt still reaches the model once through normal role preparation. Older notices without a saved display entry remain expanded. — Pi/OpenAI

Startup, attachment/resume, session restore, successful compaction and changed requirements restore the active plan above Log at the next ordinary prompt. This includes current preferences and User voice, but leaves historical Log on disk. Routine context and requested reviews quote unfinished or unreviewed goal lines. After eight unchanged turns, the next ordinary prompt carries an upkeep reminder with its reason, those goal lines and the plan path. It omits preferences, role prose and rotating quotations. Reviewed, cancelled and paused work receives no periodic upkeep; manual ticks remain unreviewed. A fresh plan refresh replaces pending upkeep; edits, pause, exit and session navigation invalidate obsolete reminders. Failed or cancelled compaction does not schedule a refresh. Missing plans are retried. Compaction still uses Pi's configured threshold.

Plan-change notices direct the agent to read the current file, including changed constraints or a final cancellation. Only our own pending notice is coalesced; unrelated queued input does not suppress it. The editable hourly `schedule_prompt` check-in remains separate.

The first request to complete the final non-cancelled goal queues a review without recording sign-off. The reviewer must read the complete plan file and actual evidence, then call `CompleteGoal` again in that review run. The review survives intervening inspection tool rounds and same-run queued delivery, but a plan edit invalidates it. Routine messages do not paste the archive. <!-- Pi/OpenAI -->

This is deliberately passive on Pi 0.85.1: tool-loop continuations, overflow retries and already-queued user messages keep Pi's existing role and compacted context, without an extra model turn just to repeat the plan. Automatic plan resync waits for ordinary prompt preparation; a delivered plan-change notice instead directs a current-file read. Pi's `triggerTurn: false` mid-run path can save a message absent from the live request snapshot; steering can instead force an unwanted turn. We use neither path for upkeep. Passive pause notices use `nextTurn`, with immediate UI feedback; stopping remains local and remote termination is unconfirmed. Quit sends no model message.

## Prompts

You can read all the prompts in conversation order in [`src/prompts.ts`](src/prompts.ts).

## Develop

```bash
pi                          # use the registered checkout above; do not add a duplicate -e
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

