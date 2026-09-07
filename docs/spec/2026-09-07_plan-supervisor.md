# Plan-aware persistent supervisor

Status: user-confirmed intent and package composition, approved 2026-09-07. The composition is implemented in the two feature worktrees. [Final validation and trial instructions](../reviews/2026-09-07_supervisor-validation.md) record passing enabled suites and real Pi/Intercom integration. Live Herdr UAT and token-saving measurements remain open in [the branch plan](../slop/plans/20260907_plan-supervisor-integration.md).

This updates the direction of [the persistent-steward branch](2026-09-03_persistent-plan-steward.md). That earlier document is a historical snapshot of the replaced checkpoint reviewer.

## User's goal

> the idea is that the supervisor agent can use less tokens, and keep track of the overall goals, keeping the work on trck, and using it's judgment and context to steer or sign off.

The worker carries detailed investigation and implementation context. The supervisor retains the overall goals, user intent, decisions, and enough progress information to judge the direction of the work. It spends its tokens on supervision rather than following every working turn.

The intended result is lower supervisory token use while keeping work on track. A succession of approval gates is not the objective. The supervisor should remember earlier reasoning and its own interventions, recognize ineffective approaches, and steer or sign off using that context.

## Proposed workflow

The user proposed:

> make a plan
> fork this agent and compact
> so supervisor has: compacted state, plan, and supervisor prompt

1. Draft the plan with the user.
2. At the planning-to-working handoff, create a separate supervisor session from the planning session's fork. Compact it unless measured context is already at most 20k tokens; unknown size does not justify skipping. The original session remains the worker.
3. Give the supervisor the compacted planning context, actual plan, and supervisor policy from `pi-intercom-supervisor` (including the existing `SUPERVISOR.md` customization route).
4. Send incremental worker updates. Retain supervisor context between checks; inactivity need not consume model tokens.
5. Let the user open either real Pi session or see both together without manually starting and pairing the second session.

The plan and supervisor policy remain available directly after compaction. Summarization should not become the only surviving copy of the user's goals.

## Two check interfaces

Routine supervision and per-goal sign-off ask different questions.

Routine checks are proposed after 50 completed worker model turns, after 60 minutes, or when the worker settles with no outstanding processes or subagents. These are candidate defaults, not measured optimal settings. Overlapping triggers should produce one check. A busy worker making progress may need no instruction; a stopped worker with unfinished work may need a continuation or a human decision.

A goal-completion attempt is a separate explicit request identifying the goal and its evidence. Approving one goal must not end supervision of the remaining plan. The existing fresh evidence judge remains in the branch; removing it has not been approved.

Use registered background-work state where available. The existing supervisor's child-process snapshot is not a complete test for outstanding work. The idle supervisor itself must not prevent the worker from ever being considered settled.

## Context and token use

- Consider native compaction for the initial supervisor fork and later supervisor-history compaction.
- Compare native summary generation with the existing VCC compiler for incremental worker views. Reporting should not require compacting the worker each time.
- Preserve user decisions and supervisory conclusions; avoid repeatedly sending the whole worker transcript.
- Reuse the existing supervisor's retention approach where useful: recent views remain detailed, older views give way to the supervisor's verdicts.
- The user suggested supervisor compaction around 100k tokens to reduce context rot and cost. Interpret this as current context size, subject to the model's limit, rather than cumulative billed tokens. Exact policy remains to be tested.
- Planning/working model persistence was considered earlier; its settings and switching behaviour are not settled.

## Preferences

Use the simplest robust composition of existing packages and supported APIs. Candidates include `pi-intercom-supervisor`, `pi-intercom`, `pi-subagents`, `pi-messenger`, and Herdr. Mentioning a package does not approve adding it as a dependency or merging its whole codebase.

Reuse the supervisor prompt and working supervision behaviour where possible. Avoid an additional orchestration framework, council, or growing collection of mechanical review gates. Routine implementation judgement belongs to the supervisor; material choices requiring the user's knowledge or preferences still come back to the user.

Keep `/goals` subcommands without required `--` prefixes. The feature should be testable in an ordinary Pi session through this branch.

Make worker/supervisor navigation direct. The user finds Fleet hard to parse. A named supervisor pane, easy switching, and a side-by-side view are preferable to requiring navigation through a fleet dashboard. A headless-run inspector is not the same thing as the real supervisor session.

## Approved implementation qualifications

Compose the existing supervisor through narrow APIs, using native Pi sessions and Herdr panes.
Human Ready is the approval: wait for successful bootstrap and pairing, then start work once. The
initial supervisor view may steer but is not a second mandatory plan-approval gate.

A demonstrably small fork (at most 20k tokens) skips the initial compaction call and reports that fact.
Unknown size does not justify skipping; other compaction failures remain visible.

If a recorded pane is missing, locate the supervisor before reopening its saved session. Missing pane
identity is not proof of process exit. Automatic recreation or an additional confirmation UI is
deferred for the branch trial, as approved by the parent during implementation.

<!-- Written by Pi from the user's conversation; integration proposals are not implementation receipts. -->
