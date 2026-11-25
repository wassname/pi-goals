# pi-goals

A Pi extension for work that takes more than one conversation. You agree on goals and how to check the results. The agent keeps those goals in view while it works, including when you're away.

## Widget mock-up

<!-- PI/Claude: mock-up rendered by widgetLines(). PI/OpenAI: moved the expanded view to the top. -->
```
● 3 goals (1 accepted, 1 active, 1 open) · 2 need you · click to collapse
  ✔ G1 Clean the labels
  ◼ G2 ✔ 3/8 · Train on the new labels
    ? Keep the 3 runs that diverged, or rerun them with a lower learning rate?
    ◼ Train the 1B model on the new labels
    ◼ Plot loss against the old run
    ◻ Compare accuracy with the old run
    ◻ Write the results table
    ✔ 3 done
  ◻ G3 ✔ 0/1 · Write the report
    ? Publish the report on the blog, or only share it with the team?
```

Click the widget in Pi's fullscreen mode or press `Ctrl+O` to expand it.

## Workflow

<!-- PI/OpenAI: shortened the workflow and linked the widget mock-up. -->
1. Run `/goals new <idea>` and answer the agent's questions.
2. Agree on the goals and a mock-up of the final report.
3. Review the plan and choose **Ready** to start work.
4. See progress and questions in the goals widget ([mock-up](#widget-mock-up)).
5. A fresh, read-only judge checks each goal before it is marked done.
6. Get the final report in the format you agreed on.

The sign-off judge is optional. With it off, the agent marks goals as self-verified. Its acceptance is another reading of the evidence, not a guarantee that the result is correct.

## Install

Add to your Pi settings:

```json
"packages": ["npm:@jl1990/pi-scheduler@0.6.0", "npm:pi-subagents@0.84.0", "~/path/to/pi-goals"]
```

<!-- PI/OpenAI: kept the minimum version and the install choice that affects reminders. -->
Requires Pi 1.2 or newer. Use Node Pi for scheduled reminders.

## Commands

```text
/goals new <idea>      discuss and draft a plan
/goals review          open Ready / Discuss in chat / Edit / Cancel
/goals pause           stop reminders; keep the goals file
/goals resume          resume paused work and restart reminders
/goals retry           retry failed reminder creation
/goals clear           stop reminders and detach the goals file
/goals judge off|on|<provider/model>
```

## Design intent

One working agent, one goals file, scheduled reminders, and an optional sign-off judge. The extension uses [pi-scheduler](https://www.npmjs.com/package/@jl1990/pi-scheduler) and [pi-subagents](https://github.com/nicobailon/pi-subagents). The agent can change the reminder interval with the scheduler's `manage_scheduled_task` tool.

The default loop statement is a few lines: state the goal and progress, start the task unchanged longest, do not poll running jobs or coordinate other sessions unless you asked, put decisions for you in `[?]` tasks, and message you only for a result that changes a goal. While goals run, pi-goals removes pi-subagents' "or report completion ... Do not silently yield" line from successful completion notices, so a finished subagent does not prompt a status report. Existing goals files keep their saved instructions.

Reminders stop when you pause, clear, or finish all goals. They can remind an agent of its goals; they cannot prevent drift between reminders. Tests cover data flow with a fake Pi and real dependency parsers. Run `PI_TEST_BIN=/path/to/node-pi npm run test:pi` for real scheduler create/remove and Ready confirmation checks, with isolated state and no model calls. Use `PI_COMPILED_BIN=/path/to/compiled-pi npm run test:compiled` for the compiled-host regression; scheduler 0.6.0 currently fails that check. Set `PI_TEST_NO_SCHEDULER=1` to check that compiled Pi starts work and records the missing scheduler.

<!-- Use paragraph: PI/Claude; provenance link: PI/OpenAI. -->
It has run for several days at a time in about ten research projects, where the sign-off judge rejected about half of the completion requests. That use was not a controlled test. How often the sign-off judge accepted a goal that was not done has not been measured. See the [project journal](docs/journal.md#2026-11-11--observed-judge-decisions) for the source.

<!-- README rewrite: PI/OpenAI. -->
