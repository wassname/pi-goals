# Switchable goal steward

The goal steward should be a real, inspectable Pi conversation. It remains read-only and resumes for reviews, but the user can switch into its saved session without losing its role.

## User-visible result

After Ready, the user can open `goal-steward`, read its review history, ask it a question, and return to the worker session without turning it into a normal editing agent.

## Goals

- [ ] goal: Make the steward session discoverable and switchable
  - [ ] Start the steward at Ready as a normal pi-subagents child with visible progress.
  - [ ] Persist its latest run and session-file identity.
  - [ ] Add `/goals steward` to switch to that session with Pi's `ctx.switchSession`.
  - failure modes: the command opens an old review, or opens a generic session with worker tools.
  - deliverable: the current steward is named and opens from `/goals steward`.

- [ ] goal: Restore the read-only steward role after a session switch
  - [ ] Add a small child-only extension that writes a durable steward-role marker and session name.
  - [ ] On pi-goals session start, detect that marker and install the steward prompt and read-only tool boundary.
  - [ ] Give every review task an explicit mode: plan-ready, checkpoint, or sign-off.
  - failure modes: a resumed steward recursively starts its own steward, edits project files, or cannot tell a checkpoint from sign-off.
  - deliverable: the opened session says `goal-steward`, has read-only tools, and treats its current review mode correctly.

- [ ] goal: Give the steward the right context and verify the round trip
  - [ ] Start fresh to avoid inheriting active pi-goals state; send a compact VCC handoff after confirming the installed API.
  - [ ] Resume the same lineage for later reviews and refresh the stored session identity.
  - [ ] Test Ready, open steward, ask a review question, return with `/resume`, then sign off a goal.
  - failure modes: a fresh steward lacks the user goal, or a fork loads pi-goals state and starts nested supervision.
  - deliverable: a test shows the user-visible round trip and one sign-off from the opened lineage.

## UAT / verification

| Scenario | What the user sees | Evidence |
| --- | --- | --- |
| success | `goal-steward` is visible, switchable, and remains read-only | flow test plus saved child transcript |
| likely failure | the command opens an older session | test resumes twice and opens the latest session path |
| sneaky failure | `/resume` restores a generic worker with write tools | role-marker session-start test proves the read-only boundary after a direct session switch |

## Appendix (context, not approved)

```py
on_ready():
    packet = vcc(parent_session)             # compact intent, plan path, current state
    run ← spawn(goal_steward, context="fresh", packet, role_marker_extension)
    state.steward ← await session_identity(run)

on_goals_steward():
    ctx.switchSession(state.steward.session_file)

on_session_start():
    if has_steward_marker(session):
        install(read_only_goal_steward_role)

on_review(mode):
    task = review_task(mode, plan_path, changed_facts)
    state.steward ← resume(state.steward.run, task)
```

Use FleetView for ordinary child visibility. Do not require Herdr: its inspector is a raw dashboard, not an interactive child session. Do not keep an LLM process idle merely to claim persistence. `pi-intercom` is out of scope unless the steward becomes a separate concurrent peer session.
