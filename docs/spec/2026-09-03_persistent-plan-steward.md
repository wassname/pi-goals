# Persistent plan steward

Historical snapshot of the replaced checkpoint-review implementation. The user's clarified objective and proposed real-session supervisor workflow are captured in [Plan-aware persistent supervisor (2026-09-07)](2026-09-07_plan-supervisor.md); the current branch implements that newer composition, with validation limitations recorded in its plan.

## Purpose

Add judgement across a plan without weakening the fresh evidence check. The steward checks intent,
trajectory, goal ordering, and scope. `CompleteGoal`'s fresh judge continues to check artifacts.

## Lifecycle

1. The human opts in with `/goals steward on`.
2. Ready forks one non-writing `oracle` through the public `pi-subagents` RPC. Work does not start
   until it returns `approve`.
3. The child process exits. Pi-subagents retains its session and run identity; no model or process
   remains active between checkpoints.
4. The first `CompleteGoal` call resumes the same child with bounded approved/current contract views
   and the proposed goal. Checkbox state is normalized and evidence detail is omitted because the fresh
   judge owns it. The steward checks contract fidelity and whether sign-off is timely.
5. `approve` creates a one-use approval bound to the goal and current working-set hash. The next
   `CompleteGoal` call consumes it and runs the existing fresh evidence judge.
6. `revise_plan`, `needs_user`, an invalid response, or a failed child never signs off the goal.

## Authority

The steward's contract forbids edits, goal completion, detailed evidence assessment, and answers to
unresolved human choices. The builtin Oracle retains inspection-only bash; pi-goals rejects a review
when pi-subagents reports a file-mutation effect, but this is not an OS sandbox. Structured decisions
are `approve`, `revise_plan`, and `needs_user`. An `approve` carrying drift or unresolved decisions is
downgraded. A separate fresh judge remains the only evidence sign-off path.

## Integration

Pi-goals uses the process-local `subagents:rpc:v1` event API. Initial execution is async `spawn` with
`context: fork`; later checks use `resume`. The current run id and approved working set persist in the
existing `pi-goals-state` session entry. `pi-intercom` is not involved.

The feature is opt-in and has no hard package dependency. If pi-subagents is absent, RPC startup
fails visibly and the plan remains in planning mode until the user retries or turns the steward off.
