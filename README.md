# pi-goals

A Pi extension for work that takes more than one conversation. You and the agent agree on one goal and on what its result will look like. They sit on one page that only you change. The agent keeps working on the goal while you are away, and a fresh reviewer checks each time it stops.

## Widget mock-up

<!-- PI/Claude: rendered by widgetLines(); collapsed, then expanded. -->
```
● goal working · Find metastable states that steer Qwen · click to expand
  → Search at layer 16 is running as job 1623: 40 steps, starts out to 6 units.

● goal working · Find metastable states that steer Qwen · click to collapse
  Search at layer 16 is running as job 1623: 40 steps, starts out to 6 units.
  If it cannot recover the planted state: debug the search, do not report a null.
  A scheduled check wakes me when the job changes state.
  Question for you: map at layer 16 or 20? I use 16, your method, until you say.
```

Click the widget in Pi's fullscreen mode or press `Ctrl+O` to expand it. It shows the agent's current note.

## The goals file

<!-- PI/Claude: the page layout, 2026-11-27. -->
One Markdown file per goal, in `.pi/goals/`.

```md
# <title>

## Goal            one paragraph, in your words: what you want and how you judge it
## Result mock-up  what you will be shown when it works
## Notes           design choices, preferences, terms, resources, what is out of scope
## Loop statement  your standing instructions, sent with every reminder

## Resume here     the agent's one note: what it saw, what is next, what if that fails
## Evidence        one line per result, with a link
```

Everything above `## Resume here` is **the page**. You approve it at Ready, and after that only you change it: edit the file, or run `/goals replan` to have the agent draft a change for your approval. An edit by the agent to the page is undone. The agent is shown your edits at its next turn.

From `## Resume here` down is the agent's. It may keep what it likes there, but only the first 15 lines of its note and the newest evidence lines are sent back to it. Checklists belong in the task tools and results in the project's journal.

## Workflow

1. Run `/goals new <idea>`. The agent replies with a proposed goal wording, a result mock-up, and at most four questions.
2. Correct the wording in chat or in the file, then choose **Ready**.
3. The agent works. A reminder each hour sends your loop statement, the goal and the agent's note.
4. Each time the agent stops with the goal open, a fresh read-only judge reads the page, the note and the agent's last message. If a job that the agent named will wake it, or only you can decide, the stop stands. Otherwise the agent is sent back to work with the judge's one finding.
5. When the agent claims the goal is met, a fresh read-only judge checks the evidence before the goal is finished.
6. You get the final report in the layout of the result mock-up.

The judge is optional. With it off, a stop gets one plain prompt to carry on, and completion is recorded as self-verified. A judge's verdict is another reading of the page and the evidence, not a guarantee that the result is correct.

## Install

Add to your Pi settings:

```json
"packages": ["npm:@jl1990/pi-scheduler@0.6.0", "npm:pi-subagents@0.84.0", "~/path/to/pi-goals"]
```

<!-- PI/OpenAI: kept the minimum version and the install choice that affects reminders. -->
Requires Pi 1.2 or newer. Use Node Pi for scheduled reminders.

A goals file written by version 0.4 or older has several goals, tasks and a log. It does not work with this version: run `/goals clear`, then `/goals new`.

## Commands

```text
/goals new <idea>      agree on the goal and its result
/goals review          open Ready / Discuss in chat / Edit / Cancel
/goals replan          reopen an approved page so the agent can draft a change
/goals pause           stop reminders and stop reviews; keep the goals file
/goals resume          resume a paused or finished goal
/goals retry           retry failed reminder creation
/goals clear           stop reminders and detach the goals file
/goals judge off|on|<provider/model>
```

## Design intent

<!-- PI/Claude: updated for the one-page goal. -->
One agent works with its usual tools. One page holds the goal, and the user owns it. Scheduled reminders repeat the user's instructions. A fresh judge, which has not seen the session, reads each stop and the final evidence. [How the design got here](docs/architecture-history.md).

See [how agent harnesses keep working toward a goal](docs/goal-implementations.md) for a source comparison with Codex, Claude Code, Hermes, and other Pi extensions. <!-- PI/OpenAI: comparison link. -->
