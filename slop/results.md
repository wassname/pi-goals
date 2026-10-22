# Goal reminder scope

Scheduled reminders now repeat the outcome, all goal titles/statuses and the complete blocks of goals marked `[/]`. These blocks include references, failure modes, completion criteria, tasks and evidence. Other sections and inactive goal details are not repeated. The existing template is used; no dependency was added.

The additional question is:

> What did you observe, and how does it change your current understanding? Given what remains uncertain, what next action is most useful toward the goal, considering its cost?

The saved Loop statement and the pre-existing default-statement edits were left unchanged.

## Checks

`slop/verification.log` records 34 passing working-tree tests, typecheck, lint and a no-model RPC load check with `goals`, `schedule` and `schedule-remove` registered. A separate copy of only the staged changes also passed all 33 tests, typecheck and lint; it excludes the pre-existing Loop-statement change and its extra test.

The scheduler-wake regression checks complete blocks for two active goals, the all-6,149-cases requirement, long evidence, nested headings, updated evidence on the next wake, removal of completed blocks, and exclusion of unrelated sections. The widget remains compact. Tests use fake Pi events; the RPC check tests extension loading, not a real hourly wake or research behaviour.

-- PI/OpenAI
