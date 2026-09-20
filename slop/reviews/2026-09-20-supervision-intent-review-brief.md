# Review brief: does pi-goals supervision follow the user's intent?

Review only. Read `README.md`, `AGENTS.md`, `src/prompts.ts`, `src/index.ts`, `src/worker-view.ts`, and relevant tests completely. Compare behavior to the user's design, not only type/test correctness. Prioritize contradictions that explain observed production behavior.

## User intent

From `README.md` / `AGENTS.md`:

> The hope is we can have a smart supervisor, with judgment and context.
>
> Supervisor steers a smaller model, adding perspective, diligence, and judgment.

> all supervisor thinking and messages should be visible.

The user clarified:

> if a worker tried to stop or change the plan it can 1) steer 2) allow an edit to plan (as long as worker didn't stop) 3) full review see if it should stop. So the paper work is only for the end (or potential end).

> the whole point is to not dump the transcript or json

> I usually have the smartest model supervising
>
> sometimes it delegates the high level thinking or critical task to a dumber subagent.

Approved new prompt text says the supervisor personally owns high-level diagnosis, research interpretation, experimental design and consequential judgment. Workers may do bounded execution, evidence gathering and independent criticism.

Other established intent:
- planning explores supplied links/project facts first, infers protected decisions, then grills the user;
- supervisor remains autonomous and goal-focused rather than waiting on infrastructure ceremony;
- ordinary running/waiting/receipt events remain visible without formal review debt;
- supervisor must not control foreign agents;
- updates should be short `/busy`-style summaries when material state changes;
- humour/kaomoji is an occasional perspective and meta-learning aid;
- worker view is compact VCC Markdown, not raw transcript/tool JSON.

## Production observations from saved supervisor tails

These are observations, not a representative sample. Sessions may still have an older extension loaded.

### Steering-lite BS-bench supervisor

The supervisor declared the initial study complete because all activation methods failed an invented blocking `useful and coherent` criterion. The user corrected it:

> there was no threshold? and to use modal as well

The supervisor then acknowledged:

> The implementation incorrectly invented two blocking thresholds: `1:4 score > 0`; `max off-axis ≤ 2.5`.
>
> Those thresholds turned ranking metrics into pass/fail conditions and stopped the actual experiment.

This is direct evidence that the supervisor accepted worker/pipeline experimental design without checking it against the user's requested experiment.

### manifold-steer supervisor

It repeatedly performed formal reviews for intermediate implementation failures/fixes:

> Formal reviews cleared: the task-1822 failure audit is accepted...

> Precision fix is technically accepted...

> Task-1823 audit formally accepted...

It also correctly diagnosed numerical/implementation failures, steered retries, protected GPU/API scope, and slowed check-ins for a long followed job.

### LUCID supervisor

A worker explicitly reported a `running` event, but the parent subsequently received an automatic `unclassified` worker-status event for the same turn. The worker view shown in that running supervisor still contained `### Recent calls and results` with raw-ish argument/result blocks. This may reflect an unreloaded pre-fix extension, but the running→automatic-unclassified sequence may be current lifecycle behavior and should be checked in source.

### meatybroth supervisor

It independently profiled the central query failure and found an 82 s versus 2.1 s query formulation difference. Its `/busy` update was concise and goal-oriented. It appears to be doing the high-level diagnosis itself, although some implementation was also performed in the supervisor pane.

## Questions

1. Does the design in current source implement the user intent above?
2. Which observed failures remain possible under current source, rather than being stale-session behavior?
3. Does automatic `agent_end` convert an explicit running/waiting/progress event into a second `unclassified` potential-stop event? If yes, give the exact path and minimal correction.
4. Are formal reviews still encouraged for intermediate fixes, despite the intended three-choice stop flow?
5. Does the new high-level-judgment wording land in all supervisor contexts that need it, including scheduled wakes and post-compaction role restoration?
6. Identify other high-impact contradictions, but avoid style findings and speculative redesign.

Return findings ordered by impact with exact file/line evidence. Separate observed production evidence, code inference, and uncertainty. Do not edit files.

— PI/OpenAI
