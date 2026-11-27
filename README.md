# pi-goals

A Pi extension for work that takes more than one conversation. You and the agent agree on one goal and on what its result will look like. They sit on one page that only you change. The agent keeps working on the goal while you are away, and a fresh reviewer checks each time it stops.

## Widget mock-up

<!-- PI/Claude: rendered by widgetLines(); collapsed, then expanded. -->
```
● goal working · 1 needs you · .pi/goals/b0ff3a-v3.md · click to expand
  "we want to find metastable states where the model self steers ... and show that they ste…
  ? Needs you: map at layer 16 or 20? I use 16, your method, until you say.
  → Now: rerunning the search at layer 16 with 40 steps (job 1623).

● goal working · 1 needs you · click to collapse
  /workspace/2026/slow-modes/.pi/goals/b0ff3a-v3.md
  "we want to find metastable states where the model self steers ... and show that they
  steer better, particularly coherent for longer." One goal, four deliverables:

  Saw: the first search stopped at 8 steps and had not converged.
  Now: rerunning the search at layer 16 with 40 steps (job 1623).
  If it fails: check that it can recover a planted state before calling it a null.
  Waiting on: job 1623; a scheduled check wakes me when it changes state.
  Needs you: map at layer 16 or 20? I use 16, your method, until you say.
  You should know: lens direction 3 was a reaction to any write, not a kept direction.
```

Click the widget in Pi's fullscreen mode or press `Ctrl+O` to expand it. It shows the goal as you wrote it and the agent's current note. A `Needs you:` line is counted in the header and shown first. The header carries the file's short path; expanded, the full path is on its own line.

## The goals file

<!-- PI/Claude: the page layout, 2026-11-27. -->
One Markdown file per goal, in `.pi/goals/`.

```md
# <title>

## Goal                  one paragraph, in your words: what you want and how you judge it
## Result mock-up        what you will be shown when it works

## Slop: Concepts        optional: an idea that keeps needing explanation, defined once
## Slop: Jargon          optional: where terms come from (paper > textbook > other field), one per line
## Slop: Notes           your preferences and design choices, one line each

## Slop: Resume here     the agent's one note: short labelled lines (Saw, Now, If it fails, Needs you)
## Slop: Evidence        one line per result, with a link
```

`## Goal` and `## Result mock-up` are what you read and approve. A heading that starts with `Slop:` holds text the agent wrote and you did not approve. The label stays on the section when it is quoted alone, so an agent or judge reading only that section still sees it. Remove the label to approve a section. The agent and the judges are told that the goal and your own messages win over a `Slop:` section. Everything above `## Resume here` is **the page**. You approve it at Ready, and after that only you change it: edit the file, or run `/goals replan` to have the agent draft a change for your approval. An edit by the agent to the page is undone. The agent is shown your edits at its next turn.

From `## Resume here` down is the agent's. It may keep what it likes there, but only the first 15 lines of its note and the newest evidence lines are sent back to it. Checklists belong in the task tools and results in the project's journal.

## Workflow

1. Run `/goals new <idea>`. The agent replies with a proposed goal wording, a result mock-up, and at most four questions.
2. Correct the wording in chat or in the file, then choose **Ready**.
3. The agent works. A reminder each hour sends the goal, "keep going until the user stops you", and the agent's note.
4. Each time the agent stops with the goal open, a fresh read-only judge reads the page, the note, the agent's last message and what you typed in the session. If a job that the agent named will wake it, or only you can decide, the stop stands. Otherwise the agent is sent back to work with the judge's one finding. While a background subagent of the session is still running there is no review: its result wakes the agent.
5. When the agent claims the goal is met, a fresh read-only judge checks the evidence before the goal is finished.
6. You get the final report in the layout of the result mock-up.

The judge does not read the session. Of the conversation it sees only your own messages, each after the last three lines of the agent message it answered; a long history keeps its first and last 1,000 lines.

The judge is optional. With it off, a stop gets one plain prompt to carry on, and completion is recorded as self-verified. A judge's verdict is another reading of the page and the evidence, not a guarantee that the result is correct.

## Install

Add to your Pi settings:

```json
"packages": ["npm:@jl1990/pi-scheduler@0.6.0", "npm:pi-subagents@0.84.0", "~/path/to/pi-goals"]
```

<!-- PI/OpenAI: kept the minimum version and the install choice that affects reminders. -->
Requires Pi 1.2 or newer. Use Node Pi for scheduled reminders.

Messages from other sessions over pi-intercom start a turn by default, and each turn ends in a stop review. To let only replies to this session's own questions start a turn, set `"inboundTrigger": "replies"` in pi-intercom's `config.json`.

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
One agent works with its usual tools. One page holds the goal, and the user owns it. Scheduled reminders repeat the goal and tell the agent to keep going. A fresh judge, which has not seen the session, reads each stop and the final evidence. [How the design got here](docs/architecture-history.md).

See [how agent harnesses keep working toward a goal](docs/goal-implementations.md) for a source comparison with Codex, Claude Code, Hermes, and other Pi extensions. <!-- PI/OpenAI: comparison link. -->
