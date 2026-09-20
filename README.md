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

Goal status is held only in the plan: `[ ]` open, `[/]` active, `[x]` reported done, `[✓]` reviewed by `CompleteGoal`, and `[-]` cancelled. Requirements changes wake the supervisor to inspect and reopen goals if needed; they do not automatically rewrite status. Review evidence stays in Log. Old `[x]` goals are not automatically certified. <!-- Pi/OpenAI -->

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

Requires Herdr. Includes [nicobailon/pi-subagents](https://github.com/nicobailon/pi-subagents) 0.66.0, pi-intercom and @jl1990/pi-scheduler 0.5.0, pinned to its official registry archive and lockfile integrity.

```bash
pi install git:github.com/wassname/pi-goals
```

Start a fresh Pi session. No worker agent file is needed: `OpenGoalWorker` uses Nico's public `project.open` surface, then the peer explicitly attaches with `AttachGoalPlan`. Use one pi-goals installation and disable separately installed copies of its bundled companions; duplicate scheduler instances send duplicate prompts.

The scheduler stores tasks under `~/.pi/agent/state/scheduler/tasks.json`, or `PI_SCHEDULER_STATE_FILE` when set. A separate Pi profile alone does not isolate this store. Goal check-ins use session scope; shared cwd/global tasks are not owned by pi-goals. Existing legacy check-ins need explicit ownership and prompt-byte review before migration; custom multiline prompts are not silently flattened.

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

`/goals` shows actions for the current mode. Drafts offer Edit, Discuss and Approve. Discuss returns to chat and waits for your input. Menu New asks for optional instructions before creating a plan; submit blank to use the conversation, or cancel to leave things unchanged. Typed `/goals new <instructions>` still starts directly. Quit (`exit` or `clear`) leaves the original plan unchanged, clears goal state and requests removal of this session's goal check-in without a model call. Clear uses verified public scheduler commands; missing commands or an unobservable result leave removal unconfirmed. Inspect `/schedules all` for the result. Matching check-in names with missing or different session scope are left unchanged with a warning. Worker processes are unchanged; inspect their native panes and use their exact Intercom identities for steering. New creates a separate draft without overwriting earlier plans, named `.pi/plan/<last-six-session-characters>-vN.md` using the next version after existing files. The title stays inside the plan; old files are not renamed. The widget shows a plain `✓` and the relative plan path for inside-project plans. External plans use the filename with an `(external)` marker; `/goals status` keeps the full location. These are plain labels, not terminal links.

### Native worker lifecycle and limits

The parent and worker keep separate native conversations. Worker attachment and stop notices use stock Intercom extension channels; assignments, reports and corrections remain visible Pi messages. Attachment metadata is saved and displayed without requesting a model acknowledgement (at a safe turn boundary when busy); blocked, done and error reports still request supervisor review. A pane-open receipt, idle state or delivery receipt does not approve a goal.

Supervisors and workers can use ordinary stock async helpers, with one writer per cwd. These are headless subagents, not additional interactive goals-workers; goal lifecycle hooks stay off even when they inherit forked history. The owning session follows results and failures through stock controls; an optional stock inspector only displays their work. Pausing blocks new owner launch/resume requests while keeping inspection and stop/interrupt available. Already-dispatched workflows may continue until stopped through their owner. <!-- Pi/OpenAI -->

`OpenGoalWorker` supplies startup only to a newly created stock Pi context. An existing live binding receives no message, so opening it does not replace its conversation or editor draft. The new worker calls `AttachGoalPlan`, reports its exact Intercom identity/model/saved-session path, and waits for a direct parent assignment. Revisions use that same session. A model preference is an instruction for agent-led configuration and verification, not a CLI override; later human changes take precedence.

`OpenGoalWorker` delegates pane ownership to stock open. When stock opens a new pane, pi-goals preserves and supersedes any recorded worker binding and correlates the replacement. When stock reports an existing pane, pi-goals preserves the current binding and returns that result for normal supervisor handling. This recovers moved/cloned supervisors without a human infrastructure modal or extension-level liveness gate. pi-goals owns attachment, report and stop correlation—not generic writer concurrency. Raw `project.open` is not a goals-worker recovery path because it lacks those hooks. — Pi/OpenAI

`/goals attach` now rejects a plan that is not already current in this context, including `attach <path> solo` and reattachment after Clear. The public roster cannot establish its supervisor's ownership; a checkbox or missing roster row is not proof. The command leaves current authority unchanged and provides read-only inspection controls. Keep the original supervisor context when available rather than clearing it to reconnect. Same-current-plan refresh and its separate explicit stopped-writer confirmation for solo recovery remain available. This guard does not solve generic adoption or cross-parent transfer. — Pi/OpenAI

## Context delivery

`worker_view` reads the attached worker's history, or the worker's own history. `Ctrl+O` expands bounded Markdown with paired calls/results and background-control references. Review and stop contexts include the same view; routine progress and receipts stay short. Saved launches and watches do not establish current job status: check the native owner before waiting or intervening. This uses VCC's compiler only, without loading its extension runtime. <!-- Pi/OpenAI -->

Routine injected `[pi-goals]` prompts are one compact custom message; `Ctrl+O` expands the exact text, and Pi converts it to the same user-role model input without an empty user bubble. Role-changing transitions retain normal prompt preparation so the new supervisor/worker role applies before the turn. — Pi/OpenAI

Startup, attachment/resume, session restore, successful compaction and changed requirements restore the active plan above Log at the next ordinary prompt. This includes current preferences and User voice, but leaves historical Log on disk. Routine context and requested reviews quote unfinished or unreviewed goal lines. After eight unchanged turns, the next ordinary prompt carries an upkeep reminder with its reason, those goal lines and the plan path. It omits preferences and role prose; occasional rotating perspective quotations accompany supervision upkeep. Reviewed, cancelled and paused work receives no periodic upkeep; manual ticks remain unreviewed. A fresh plan refresh replaces pending upkeep; edits, pause, exit and session navigation invalidate obsolete reminders. Failed or cancelled compaction does not schedule a refresh. Missing plans are retried. Compaction still uses Pi's configured threshold.

Plan-change notices direct the agent to read the current file, including changed constraints or a final cancellation. Only our own pending notice is coalesced; unrelated queued input does not suppress it. The editable hourly `schedule_task` check-in remains separate. Ready and explicit resume ask the supervisor to list jobs first and create the session-owned reminder only when missing; ordinary reloads and wakes do not create it. It uses an explicit prompt action, session scope and a short one-line wake that reads the current attached plan. Inspect recurrence with `/schedules all`; change the interval through `manage_scheduled_task` without resending the prompt. Pause disables the owned check-in and retains its prompt/interval; resume may enable only the unchanged job recorded by that pause. Disabled jobs survive reload.

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

For deterministic fixtures, run `node scripts/prepare-trial.mjs INSTALLED_PI_ROOT --offline LOOPBACK_MODEL_URL` with an existing HTTP loopback model server. This route loads only the candidate's required packages and the existing offline model fixture, without reading your profile or copying credentials. Without `--offline`, the helper retains your installed packages and model settings. Both routes isolate scheduler storage and only prepare files; neither launches Pi. <!-- Pi/OpenAI -->

## License

MIT

