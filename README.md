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

<!-- PI/OpenAI: restored the short design summary. -->
One agent works with its usual tools and one goals file. Scheduled reminders repeat your instructions, and an optional sign-off judge checks the evidence.

See [how agent harnesses keep working toward a goal](docs/goal-implementations.md) for a source comparison with Codex, Claude Code, Hermes, and other Pi extensions.

<!-- README rewrite and comparison link: PI/OpenAI. -->
