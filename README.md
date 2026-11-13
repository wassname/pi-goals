# pi-goals

A Pi extension for work that takes more than one conversation. You agree on goals and how to check the results. The agent keeps those goals in view while it works, including when you're away.

## Workflow

1. Run `/goals new <idea>`. The agent explores and asks clarifying questions before drafting a plan.
2. Agree on the goals and a short mock-up of how you'll review the results. The mock-up shows possible outcomes, not results already measured.
3. Review the plan and choose **Ready** to start work. During planning, the agent can only read, search, consult helpers, and write the goals file or notes under `slop/`.
4. Follow the work in a widget: one line per active goal, with its tasks finished and the task in progress. Hourly reminders are kept short so they get read, and ask the agent to state the overall goal and its progress in one or two lines, name the next task and start it. They show your loop statement, the aim, one status line per goal, and the open tasks of active goals, longest unchanged first, with their age. Tasks that wait on your decision are listed apart. They also say how often they fire and that the agent can change it. Failure modes, evidence and task details stay in the goals file. After Ready, compaction or resume the agent gets the aim, your words (User voice) and the goals, then the rest of the file above its Log and your newest messages, with advice to step back to the goal and to look for answers before waiting for you. To keep this short however long the task list gets, finished tasks are counted, notes are sent only for tasks in progress or waiting on you, and accepted goals keep one line. The Log, the left-out task text and your older messages stay in the file for it to search.
5. Before a goal is ticked off, a fresh, read-only subagent checks the evidence. This sign-off judge can reject completion if the work misses what you asked for.
6. When the last goal is finished, reminders stop and the agent is asked for the final report in the review layout you agreed.

The sign-off judge is optional. With it off, the agent marks goals as self-verified. Its acceptance is another reading of the evidence, not a guarantee that the result is correct.

## Install

Add to your Pi settings:

```json
"packages": ["npm:@jl1990/pi-scheduler@0.6.0", "npm:pi-subagents@0.84.0", "~/path/to/pi-goals"]
```

<!-- PI/OpenAI: scheduler installation and startup recovery. -->
Requires Pi 1.2 or newer (pi-subagents 0.84 needs it). Install and load pi-scheduler 0.6.0 or newer separately; it is not bundled. Install pi-subagents 0.84.0 separately for the sign-off judge.

Scheduled work is tested with Node Pi 1.5.2 and scheduler 0.6.0. The unmodified scheduler 0.6.0 package fails to load `graceful-fs` in compiled Linux Pi 1.4.0 and 1.5.2. Use Node Pi for scheduled work until that upstream loading problem is fixed. With the scheduler omitted, planning and recovery remain available in the tested compiled versions. Scheduler 0.5.1 is rejected before Ready can use it.

Ready keeps work blocked until the scheduler's session-scoped creation receipt is confirmed. If startup remains pending, `/goals resume` checks again without creating another reminder. If creation failed, fix the scheduler's startup error, then use `/goals retry`. Pause or clear cancels startup and preserves the goals file. Changed goals must be reviewed again.

## Commands

```text
/goals new <idea>      discuss and draft a plan
/goals review          open Ready / Discuss in chat / Edit / Cancel
/goals pause           stop reminders; keep the goals file
/goals resume          restart reminders, or check pending startup
/goals retry           retry failed reminder creation
/goals clear           stop reminders and detach the goals file
/goals judge off|on|<provider/model>
```

## Goals and evidence

The plan is saved in `.pi/goals/`. It opens with the aim in one or two lines, then the goals with their tasks and evidence, the review mock-up and your words; it keeps your messages word for word at the end. A result takes one line in the goals, with a link to the heading that holds its numbers and quotes (in the Log or the project's journal). Each goal describes how the work could look complete but still be wrong, and what check would catch that.

You can edit the file at any time. The next reminder uses your changes. The agent should ask before changing your instructions or recorded preferences.

Goal marks: `[ ]` open, `[/]` active, `[x]` self-verified, `[✓]` accepted by the sign-off judge, `[-]` cancelled. The widget shows one line per active goal, for example `◼ G2 3/8 · Train on the new labels · +2 in progress` when two more tasks are in progress. The status line counts accepted goals and names the goals file.

<!-- [?] paragraph: PI/Claude. -->
A task marked `[?]` waits on your decision. The widget lists these first, as `? needs you (G2): <question>`, and the status line counts them. The agent is asked to write the label as the whole question, with the options, what each changes, its recommendation and what it assumes meanwhile in the task's notes, so you can answer without the chat history.

While goals run, tasks stay in this file instead of a separate pi-tasks list.

The sign-off judge reads the goals file and cited files; it cannot run tests. The working agent must run checks and save their output first. Its reviews are saved in `.pi/goals/reviews/`.

## Design intent

One working agent, one goals file, scheduled reminders, and an optional sign-off judge. The extension uses [pi-scheduler](https://www.npmjs.com/package/@jl1990/pi-scheduler) and [pi-subagents](https://github.com/nicobailon/pi-subagents). The agent can change the reminder interval with the scheduler's `manage_scheduled_task` tool.

The default loop statement is a few lines: state the goal and progress, start the task unchanged longest, do not poll running jobs or coordinate other sessions unless you asked, put decisions for you in `[?]` tasks, and message you only for a result that changes a goal. While goals run, pi-goals removes pi-subagents' "or report completion ... Do not silently yield" line from successful completion notices, so a finished subagent does not prompt a status report. Existing goals files keep their saved instructions.

Reminders stop when you pause, clear, or finish all goals. They can remind an agent of its goals; they cannot prevent drift between reminders. Tests cover data flow with a fake Pi and real dependency parsers. Run `PI_TEST_BIN=/path/to/node-pi npm run test:pi` for real scheduler create/remove and Ready confirmation checks, with isolated state and no model calls. Use `PI_COMPILED_BIN=/path/to/compiled-pi npm run test:compiled` for the compiled-host regression; scheduler 0.6.0 currently fails that check. Set `PI_TEST_NO_SCHEDULER=1` to check that compiled Pi preserves planning and reports the missing scheduler instead of starting work.

<!-- Use paragraph: PI/Claude; source slop/analysis/20261111_judge_reviews.py. -->
It has run for several days at a time in about ten research projects, where the sign-off judge rejected about half of the completion requests. That use was not a controlled test. How often the sign-off judge accepted a goal that was not done has not been measured.

<!-- README rewrite: PI/OpenAI. -->
