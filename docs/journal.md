# pi-goals journal

## 2026-11-25 — Ready starts work without waiting for the scheduler

The old startup checked for a scheduler receipt before the scheduler finished saving it. In a disposable Pi session, the valid receipt arrived but the goals stayed `starting`. Separately, a Log-only edit invalidated the old whole-file approval check. [The fix](https://github.com/wassname/pi-goals/commit/9ed41d2) separates plan approval from reminder creation. With Pi 1.5.2 (Node) and scheduler 0.6.0, a forced scheduler write error left work `working` and produced a warning in both the transcript and goals Log. With storage restored, `/goals retry` created a reminder without restarting work. This did not fix the scheduler loading problem on compiled Pi.

## 2026-11-11 — Observed judge decisions

The [review output](https://github.com/wassname/pi-goals/blob/9ed41d2/slop/analysis/out/20261111_judge_reviews.txt#L1-L8) reports 116 rejections in 238 reviews across 130 goals. Repeat reviews count separately. This was an observation of project sessions, not a test of how often the judge accepts incomplete work. [Analysis script](https://github.com/wassname/pi-goals/blob/9ed41d2/slop/analysis/20261111_judge_reviews.py).

## 2026-11-07 — Where automated wakes came from

In one research session, intercom messages accounted for more wakes than goal reminders. The [historical analysis](https://github.com/wassname/pi-goals/blob/9ed41d2/slop/analysis/20261107_wake_sources.md) and [before-and-after examples](https://github.com/wassname/pi-goals/blob/9ed41d2/slop/reviews/20261107_quieter_loop_before_after.md) document why the reminder was shortened. They do not measure whether the shorter reminder improved goal completion.

<!-- PI/OpenAI: observations consolidated from retired scratch files. -->
