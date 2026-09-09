# Recovery commands

Implemented directly by Pi/OpenAI at the user's request, on `feature/simple-visible-supervision`, base `cecb1e9` plus the existing uncommitted autonomy changes. The active global installation was not replaced.

## Commands

- `/goals help`: available commands and limits.
- `/goals status`: phase, peer connectivity, recorded panes/session files and last runtime failure.
- `/goals stop`: stop goal continuation and supervision; retain the plan and pair.
- `/goals exit`: stop and return to ordinary chat, retaining files. Supervisor sessions remain inspection-only.
- `/goals reconnect`: send the existing pair's identity handshake. Does not fork or authorize work.
- `/goals resume`: in the worker, resume previously authorized work after peer acknowledgement. A stopped draft or changed plan returns to planning and still needs Ready. In the supervisor, directs the human to the worker for authorization.
- `/goals supervisor`, `/goals worker`, `/goals zoom`: existing pane navigation.

Stop/exit cancel startup, an outstanding Ready selection and sign-off. They persist across reload. They do not kill independently running processes. Peer notification is best-effort and explicitly unconfirmed; use the other pane's stop command if it is disconnected. A pause identity prevents an old resume request from undoing a newer stop. Permanently ended pairings are not revived by reconnect.

## Observed interactive behaviour

Used real Pi 0.85.1 in a dedicated Herdr pane, with the normal global extensions, skills, prompts and themes. Project settings replaced only the old pi-goals package selection with the candidate. No global settings or package installation changed. The pane was closed after the check.

This was an **operator-seeded unapproved draft**, not an autonomous task or a model-produced plan. There were no model responses beyond the explicitly labelled fixture marker. The purpose was to exercise the public commands and persisted state in real Pi.

Saved [verification output](evidence/2026-09-09-recovery/verification.log) reports:

> PASS: stop persisted paused draft.
> PASS: resume restored planning without Ready authorization.
> PASS: exit persisted ordinary-chat state.
> PASS: no assistant turn beyond operator fixture marker.
> PASS: draft bytes unchanged.
> PASS: actual reload rendered; stopped status retained.
> PASS: reconnect without a pair reports failure instead of launching one.
> PASS: fresh-shell --session retained exit; status reports ordinary chat.

The [reload capture](evidence/2026-09-09-recovery/reload-pane.txt) shows the actual reload notice and stopped widget. The [resume capture](evidence/2026-09-09-recovery/resume-pane.txt) says “Draft restored; no work started.” The [fresh-shell capture](evidence/2026-09-09-recovery/fresh-status-pane.txt) says “Goals: ordinary chat (goals exited).” These establish command behaviour in the interactive runtime, not supervisor judgment.

Local fixture and detailed command receipts: `/tmp/pi-goals-recovery-functional/`. Source diff: `/tmp/pi-goals-recovery-implemented.diff`.

## Automated checks

The final `npm test`, typecheck, lint, build and `git diff --check` completed successfully. Saved [npm test output](evidence/2026-09-09-recovery/npm-test.log), [typecheck](evidence/2026-09-09-recovery/typecheck.log), [lint](evidence/2026-09-09-recovery/lint.log) and [build](evidence/2026-09-09-recovery/build.log) are supporting checks, not substitutes for paired functional acceptance.

## Remaining acceptance

Real paired worker/supervisor recovery during bootstrap compaction and sign-off, and the autonomous two-goal trial, remain pending. Paired transport regressions use an in-process broker harness; they do not replace those checks. The encrypted-compaction replay mismatch is a separate unresolved issue; this change does not disable its guard or claim to fix it.
