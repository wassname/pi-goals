<!-- Draft by PI/Claude 2026-11-07 for wassname's sign-off. Not posted. Target: https://github.com/nicobailon/pi-subagents/issues -->
<!-- Already fixed upstream, so NOT in this issue: user-role PARENT_WAKE_TEXT (removed in v0.80.0, PR #2990, issue #2976);
     unlabelled notices (wrapped in <pi_subagents_notice> since v0.81.0, PR #3002, issue #2994). -->

# Completion notices push the parent to report every result; allow quiet completions for ordinary async runs

## Summary

Every waking completion notice ends with `COMPLETION_ACTION` (`src/shared/parent-wake.ts:4` on main at de6957be):

> Read the saved results above and resume the already-authorized parent task, **or report completion**. If approval is required, explicitly ask the user. **Do not silently yield**, rerun completed work, or infer new authorization.

If the woken turn has no visible text or tool call, `notify.ts:1067` adds one more turn:

> Completion wake ended silently. See the subagent completion notices above. Read the saved results above and resume ...

So a parent cannot just take in a result and stay idle. We think the cheapest way for a model to satisfy "do not silently yield" is a short message to the user. In a long-running parent that delegates often, each completion then becomes a user-facing status report. We also think the repeated "resume ... or report" pushes some parents toward coordinating their children. That is an inference, not something we measured.

#2716 added the continuation for a real failure: parents returned empty responses and left supervisor requests unanswered. This issue is not about that case. It is about successful completions where nothing needs doing now.

## Evidence

One parent session (pi-subagents 0.79.0, Pi 1.4.0, about 4 days, a goals loop plus async subagents and other sessions over pi-intercom). Counts come from the session JSONL:

- 20 user-role `Inspect subagent updates above ...` wakes and 17 `subagent-notify` messages. (The user-role wake line is gone since v0.80.0. The `Parent action: ...` line on each notice is unchanged.)
- The user's verdict on the parent's behaviour: "Too much getting obsessed with supervising tasks. why? Ignoring goal prompt." and later "honestly you don't need to supervise or coordinate hardly at all. It's a distraction it seems. I never asked you to."

pi-subagents is one of several wake sources there (pi-intercom inbound messages were the largest). We can't separate its share of the behaviour. The wording is the part this extension controls.

## Suggested fix (any one helps)

1. **Wording.** Drop "or report completion" and "Do not silently yield". For example: "Use these results in the already-authorized parent task. If approval is required, ask the user. Do not rerun completed work or infer new authorization." Keep the #2716 continuation only for the case it was built for: pending supervisor requests, or a failed, paused or stopped run.
2. **Quiet ordinary runs.** `quiet: true` already exists for recurring schedules ("Successful automatic fires stay visible without a parent turn; failed, stopped, or paused outcomes still wake the session", docs/missions.md). Offer the same as a per-call option, or as a config default (e.g. `completionWake: "turn" | "quiet"`), for ordinary async runs. #2994 proposed this as fix 3, but #3002 did only the provenance tag.

Option 2 fits parents that wait with `bg_wait` or read results on their own schedule. Option 1 helps everyone.

Happy to test either.
