# Persistent goal steward

> "ideally the supervisor has the high level planning and goal context, doesn't get overloaded and have to compact, is cheap as it doesn't use many tokens (high level only)"
>
> "try again with more thought using pi-subagents much more to simplify out code and rely on that so our code is simple"

- [x] goal: A cheap read-only steward keeps the goal context across reviews
  - [x] register one `goal-steward` agent through the public pi-subagents event bus
  - [x] start it with fresh context at Ready and resume its latest saved run at checkpoints
  - [x] send the plan path and a bounded progress delta; require the steward to reread the plan
  - failure modes: every review starts fresh; the steward receives the full worker transcript; the steward can edit; reload loses its run
  - deliverable: tests show one spawn followed by resume, a saved latest run ID, read-only tools, bounded review prompts, and reload recovery
  - evidence: [`../audits/20260905_steward-probe.json`](../audits/20260905_steward-probe.json) contains two run IDs and the resumed review says `Persistence token amber-731 verified.`

- [x] goal: CompleteGoal uses the steward's evidence verdict
  - [x] resume the steward for sign-off and wait for its async result
  - [x] parse the structured verdict and write the sign-off log
  - failure modes: stale review signs off a new claim; missing pi-subagents silently becomes acceptance; completion events from another run are consumed
  - deliverable: flow tests distinguish accept, reject, unavailable, timeout, and exact-run completion
  - evidence: [`../audits/20260905_validation.log`](../audits/20260905_validation.log) says `Tests  36 passed (36)` and `Checked 12 files in 14ms. No fixes applied.`

## UAT / Verification

- [x] `npm test`, `npm run typecheck`, and `npm run lint` pass.
- [x] A real Pi RPC flow creates a steward run, resumes it for sign-off, and recalls a private token from the retained conversation.
- [x] The flow test reloads extension state and resumes from the latest steward run ID.

## Appendix (context, not approved)

Use pi-subagents 0.65.1 public RPC (`spawn`, `resume`) and `subagent:async-complete`. Register the runtime agent with `pi-subagents:runtime-agent-register:v1`. Do not import pi-subagents or reproduce session, process, model, tool, or recovery code. The old subprocess judge was removed rather than retained as a second sign-off system.

## Log

- 2026-09-05: Unit and flow tests cover read-only registration, spawn then resume, exact-run completion, timeout, reload, and accept/reject sign-off.
- 2026-09-05: The Pi 0.85.0 + pi-subagents 0.65.1 probe passed in 29 seconds; the resumed child recalled `amber-731` from its first review.

— Pi/Codex
