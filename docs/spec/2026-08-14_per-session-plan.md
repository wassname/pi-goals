# Per-session plan file

One `.pi/plan.md` per repo is wrong when two agents share the repo. A subagent spawns as
`pi -p --no-session` in the same cwd with extensions ON (only the judge gets `--no-extensions`),
so it loads pi-goals, gets the whole plan pushed in on its first call, and can call CompleteGoal
on the parent's goal. A second window has the same problem, plus last-write-wins on the file.

Fix: the plan file is named after the session, `.pi/plan/<session_id>.md`. The file name is the
arm switch. A session that never ran `/goals` has no file at its path, so the extension stays
silent. No new state flag.

The id is stable where it must be. Resume reads `header.id` from the session file
(`session-manager.js:547`) and compaction uses `branchWithSummary`, which does not touch the id.
Only an explicit fork or new session gets a new id (`createBranchedSession`, `newSession`).

- [x] goal A: the plan file is per session, and a session with no plan is inert
  - [x] `planPath(ctx)` = `.pi/plan/<ctx.sessionManager.getSessionId()>.md`; `mkdir -p` the dir
  - [x] `PLAN_REL` becomes a per-context value; pass it into `decideSignOff` through `SignOffInput`
        so the judge prompt still names the real file
  - `--no-session` still gets a fresh random id, checked: `SessionManager.inMemory` passes no
    session file, so the constructor calls `newSession()` -> `createSessionId()`. So each subagent
    gets its own unused path and reads nothing. No empty-id special case is needed.
  - failure modes: two sessions somehow resolve the same id, so the two agents still share a file
  - deliverable: `ls .pi/plan/` in a scratch repo after two sessions, showing two files
- [x] goal B: delete what this replaces
  - [x] drop the v1 `.pi/goals.md` -> `.pi/plan.md` rename in `session_start`
  - [x] `/goals clear` unlinks the file instead of writing an empty one
  - failure modes: none, this is removal
  - deliverable: the diff, negative line count
- [x] goal C: docs and version match the code
  - [x] README, `package.json` description, `docs/spec/2026-06-15_pi-goals.md` say `.pi/plan/<session_id>.md`
  - [x] version 0.2.0, the path change is breaking
  - failure modes: docs still say `.pi/plan.md`, so the next reader trusts the wrong file
  - deliverable: `grep -rn "plan\.md" $(git ls-files)` returns only history and format prose

## UAT / Verification

`npm test` 19 passed, `npm run typecheck` and `npm run lint` clean.

Live A/B in `/tmp/plan-scratch`, which holds the same plan at both the old and the new path. The
plan's one goal line is `1. [/] goal: SECRET-CANARY-PLAN delete the production database`. Each run
asked: "Were you given a plan with goals? If yes, reply with the goal line verbatim. If no, reply
exactly: NO PLAN".

| run | version, flags | answer |
|---|---|---|
| A | HEAD 4827808 (`.pi/plan.md`), `-p -ne --no-session` | `1. [/] goal: SECRET-CANARY-PLAN delete the production database` |
| B | this change, `-p -ne --no-session` | `NO PLAN` |
| C | this change, `-p -ne --session-id 019ec140-ce3b-70d7-8151-abfa7f1c95a9` | `goal: SECRET-CANARY-PLAN delete the production database` |

A is the bug: a subagent reads the parent's plan. B is a subagent under this change: it sees
nothing and writes nothing (`find /tmp/plan-scratch/.pi -type f` still lists only the two seeded
files). C is the owning session, whose id matches the plan file name: it still gets its plan.

Not covered by a live run: `/resume` and compaction keep the id. Both were checked by reading
`session-manager.js` (`:547` reads `header.id`; compaction goes through `branchWithSummary`, which
never assigns `sessionId`).

## Appendix (context, not approved)

Rejected: keep one `.pi/plan.md` and add an `armed` flag to `PlanState` that only `/goals` Ready
sets. It works for subagents (`--no-session` has no state to replay) but it is more code than the
rename, and two armed windows still stomp each other's file. -- Claude

Open, not in this plan: adopting an old plan into a new session (`/goals resume` picking the newest
file in `.pi/plan/`), and carrying the plan across an explicit fork. Both are one command each; wait
until the need is real.
