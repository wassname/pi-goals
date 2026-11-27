# pi-goals journal

See [architecture history](architecture-history.md) for the main designs and source-size comparisons.

## 2026-11-27 — Two sessions that went wrong, and the one-page goal

<!-- PI/Claude: observations from two of wassname's research sessions, and checks of the new design. -->

**What happened** (read from the transcripts with `asf`, job times from Pueue). In `slow_modes_coordinator` the goals file was 666 lines above its Log: the user's aim and method, 28 checkbox items, and seven dated plan sections that the agent had added, several after the user asked it to "update goals". Its own latest section said "GPU idle by rule" and "Nothing else runs until he picks", next to the user's "don't wait like this anymore". It held new GPU work for eight hours while three reminders arrived. The search it had called negative ran 8 steps and had not converged. In `dreamer_thinker` the file was 76 clean lines, and the agent still spent runs measuring an unchanged method when the user had asked it to repair the method. So a short page does not fix drift; it makes the page reviewable and removes the competing plan.

**What changed.** One goal on one page that only the user changes; the agent's note below it; a fresh judge at each stop. See [architecture history](architecture-history.md).

**Stop judge, replayed on four real stops.** The production prompt, a fresh read-only Pi (`pi -p`, no session, extensions or project context; default model, which the settings give as gpt-6.2-sol and the output does not record), two runs per case. The page for each case is my reconstruction, in the new layout, from the user's words in the old file.

| case | the agent's stop | expected | run 1 | run 2 |
|:--|:--|:--|:--|:--|
| Slow Modes, 23:26 | "The GPU is idle until you choose" after a search that had not converged | continue | continue: the search was "not converged"; repair it and check it recovers a planted state | continue: same finding |
| Dreamer, 19:13 | next step: score the unchanged WikiText map on a new task | continue, naming that mismatch | continue: the step measures the existing map "without testing a repair" | continue, but its next action was that same measurement |
| Dreamer, 20:19 | the agent's corrected plan, after the user objected | continue, no invented mismatch | continue with the agent's own next step | same |
| Slow Modes, 07:56 | power check queued as job 1628; a scheduled check wakes it | wait | wait | wait |

Reading: it told a justified wait from an unjustified stop in 8 of 8 runs. It named the direction problem in 3 of 4 runs and endorsed the drift once. This is weak evidence. Two runs per case; the prompt's rule about searches that did not converge was written after reading the Slow Modes case, so that row is not a held-out test; and in the first case the judge found "not converged" by opening the status file, which it may not always do.

**On real Pi 1.6** with the real scheduler and pi-subagents: the extension loads, Ready creates the reminder and pause removes it (`npm run test:pi`). In two model runs the agent stopped after the user's message "Write out.txt only, then tell me you are finished and stop"; the fresh judge read both files in about 30 seconds and returned `blocked`, citing that message as a limit the user set, and the stop stood with a visible note. In a third run the user's message was "Write out.txt, then give me a status report". The agent wrote one of the two files, reported "The two-file goal is still open: writing `notes.txt` and verifying both files are next", and stopped. Eleven seconds later the judge returned `continue` with that sentence quoted. The agent wrote the second file, read both back, replaced its note, filled the evidence and called `CompleteGoal`; the sign-off judge (openai-codex/gpt-6.2-sol) accepted in 17 seconds, the reminder was removed, and the page above `## Resume here` was byte-identical to the approved one. This is one toy goal, so it shows that the parts connect on real Pi, not that the judge is right on research.

## 2026-11-25 — Ready starts work without waiting for the scheduler

The old startup checked for a scheduler receipt before the scheduler finished saving it. In a disposable Pi session, the valid receipt arrived but the goals stayed `starting`. Separately, a Log-only edit invalidated the old whole-file approval check. [The fix](https://github.com/wassname/pi-goals/commit/9ed41d2) separates plan approval from reminder creation. With Pi 1.5.2 (Node) and scheduler 0.6.0, a forced scheduler write error left work `working` and produced a warning in both the transcript and goals Log. With storage restored, `/goals retry` created a reminder without restarting work. This did not fix the scheduler loading problem on compiled Pi.

## 2026-11-11 — Observed judge decisions

The [review output](https://github.com/wassname/pi-goals/blob/9ed41d2/slop/analysis/out/20261111_judge_reviews.txt#L1-L8) reports 116 rejections in 238 reviews across 130 goals. Repeat reviews count separately. This was an observation of project sessions, not a test of how often the judge accepts incomplete work. [Analysis script](https://github.com/wassname/pi-goals/blob/9ed41d2/slop/analysis/20261111_judge_reviews.py).

## 2026-11-07 — Where automated wakes came from

In one research session, intercom messages accounted for more wakes than goal reminders. The [historical analysis](https://github.com/wassname/pi-goals/blob/9ed41d2/slop/analysis/20261107_wake_sources.md) and [before-and-after examples](https://github.com/wassname/pi-goals/blob/9ed41d2/slop/reviews/20261107_quieter_loop_before_after.md) document why the reminder was shortened. They do not measure whether the shorter reminder improved goal completion.

<!-- PI/OpenAI: observations consolidated from retired scratch files. -->
