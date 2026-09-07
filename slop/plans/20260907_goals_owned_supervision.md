# One-package visible supervision

## Goal

Replace the pi-goals → pi-supervise → pi-intercom runtime chain with one pi-goals extension in two Pi processes. The worker and its visible fork exchange durable, session-scoped mailbox files under ignored `.pi/`.

## Design decisions

- A fork copies session history; it does not provide messaging. The mailbox is the explicit local-process channel.
- Ready waits for the supervisor's durable `ready.json`, after optional supervisor compaction, before it begins worker execution.
- Worker views are written on Ready, settle, 50 turns, and 60 minutes. The supervisor polls views and writes one steer request. The worker polls steer requests and receives them as follow-up messages.
- The canonical plan remains a direct path in the supervisor prompt. It is not a summary artifact.
- Keep the approval checkpoint: stopped view, no active work, clean commit, plan evidence, and tracked verification output.
- No external `pi-supervise` or `pi-intercom` runtime dependency remains.

## Risks and discriminators

| Risk | Discriminator |
| --- | --- |
| Worker begins before a supervisor is ready | Ready test sees `ready.json` before state changes to working or sends the execution prompt. |
| Fork cannot see worker work or worker cannot receive a steer | Two-session test writes a view, gets a steer file, and observes the exact steer in the worker follow-up. |
| Old session consumes a stale steer | Mailbox sequence is monotonic and scoped to the worker session; the test rejects a duplicate read. |
| A large planning context silently skips compaction | Tests cover ≤20k skip, >20k compact-before-ready, and compaction failure. |

## Validation

- `npm run lint`
- `npm run typecheck`
- `npm test`
- `npm run test:rpc`
- Real local Herdr: create plan, Ready, worker/supervisor pair, commit saved verification output, supervisor approval, CompleteGoal.

-- PI[Kimi K3]
