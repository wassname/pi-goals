# pi-goals

A Pi extension for work that takes more than one conversation. You agree on goals and how to check the results. The agent keeps those goals in view while it works, including when you're away.

## Workflow

1. Run `/goals new <idea>`. The agent explores and asks clarifying questions before drafting a plan.
2. Agree on the goals and a short mock-up of how you'll review the results. The mock-up shows possible outcomes, not results already measured.
3. Review the plan and choose **Ready** to start work. During planning, the agent can only read, search, consult helpers, and write the goals file or notes under `slop/`.
4. Follow goals and tasks in a widget. Hourly reminders are kept short so they get read: your loop statement, the outcome, one status line per goal, and the open tasks of active goals, longest unchanged first, with their age. They also say how often they fire and that the agent can change it. Failure modes, evidence and task details stay in the goals file; after Ready, compaction or resume the agent gets the whole file, with advice to step back to the goal and to look for answers before waiting for you.
5. Before a goal is ticked off, a fresh, read-only subagent checks the evidence. This judge can reject completion if the work misses what you asked for.

The judge is optional. With it off, the agent marks goals as self-verified. A judge's acceptance is another reading of the evidence, not a guarantee that the result is correct.

## Install

Add to your Pi settings:

```json
"packages": ["npm:pi-subagents@0.84.0", "~/path/to/pi-goals"]
```

Requires Pi 1.2 or newer (pi-subagents 0.84 needs it; loads in Pi 1.4.0). The scheduler is bundled; install pi-subagents 0.84.0 separately for the judge.

## Commands

```text
/goals new <idea>      discuss and draft a plan
/goals review          open Ready / Discuss in chat / Edit / Cancel
/goals pause           stop reminders; keep the goals file
/goals resume          restart reminders
/goals clear           stop reminders and detach the goals file
/goals judge off|on|<provider/model>
```

## Goals and evidence

The plan is saved in `.pi/goals/`. It keeps your messages word for word, alongside the agreed result, review mock-up, goals, tasks and evidence. Each goal describes how the work could look complete but still be wrong, and what check would catch that.

You can edit the file at any time. The next reminder uses your changes. The agent should ask before changing your instructions or recorded preferences.

Goal marks: `[ ]` open, `[/]` active, `[x]` self-verified, `[✓]` accepted by the judge, `[-]` cancelled. The widget shows open tasks for active goals. While goals run, tasks stay in this file instead of a separate pi-tasks list.

The judge reads the goals file and cited files; it cannot run tests. The working agent must run checks and save their output first. Judge reviews are saved in `.pi/goals/reviews/`.

## Design intent

One working agent, one goals file, scheduled reminders, and an optional judge. The extension uses [pi-scheduler](https://www.npmjs.com/package/@jl1990/pi-scheduler) and [pi-subagents](https://github.com/nicobailon/pi-subagents). The agent can change the reminder interval with the scheduler's `manage_scheduled_task` tool.

The default loop statement tells the agent to start with the task untouched longest, not to poll running jobs, and to message you only for decisions or results that change a goal. It coordinates other sessions only if you asked, and then minimally. While goals run, pi-goals removes pi-subagents' "or report completion ... Do not silently yield" line from successful completion notices, so a finished subagent does not prompt a status report. Existing goals files keep their saved instructions.

Reminders stop when you pause, clear, or finish all goals. They can remind an agent of its goals; they cannot prevent drift between reminders. Tests cover data flow with a fake Pi and real dependency parsers. A multi-hour unattended run has not been tested.

<!-- README rewrite: PI/OpenAI. -->
