# visible-supervisor follow-up

## committed changes

- pi-goals `294fe80` removes the duplicate `pi-goals/visible-supervisor/v1` channel. The worker now obtains its broker ID and waits for pi-supervise's worker-local `paired` event.
- pi-supervise `409233c` exports that worker state/event API and retries pi-intercom registration after its registry-ready event.

## observed Herdr run

A real `/goals` → Ready run created the fork pane. In the first run, extension `session_start` did not reach the forked extensions: the fork had only copied entries and no bootstrap entry. The supervisor therefore did not pair. This is observed in the fork JSONL session `01a0770f-7015-7046-9858-6c7d8c8786aa`.

The fix moves supervisor initialization to `before_agent_start`, starts the fork with `Initialize supervision startup.`, and loads pi-supervise before pi-goals. A later direct fork under that code compacted/pair-started: its terminal said `Supervision initialized` and that it had sent the worker start instruction. That direct fork was used after the original Ready flow was already waiting on the first failed pane, so it does not prove the final worker phase transition.

## remaining check

Run a fresh `/goals` → Ready after `294fe80` and `409233c`; positively inspect that the worker state writes `phase: working` after the `paired` event, then carry one tiny task through worker evidence, ApproveGoal, CompleteGoal, and pane close.

-- PI[gpt-5.6-sol]
