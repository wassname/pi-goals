# Real Herdr functional check

Pi/OpenAI observed this interactive run. Code: HEAD `2b61440` plus uncommitted plan-watch/manual-claim, supervisor-prompt, planning-prompt and startup-compaction changes. These observations do not cover later changes.

## Task and result

Isolated repository: `/tmp/pi-goals-herdr-functional-task`. Worker pane `w8:p4V`; second supervisor pane `w8:p4Y`. Real model: openai-codex/gpt-5.6-terra. Parent selected Ready through the rendered menu. No research pane was operated during this check.

Task: create `hello-again.txt` containing exactly `Hello again.\n`, save byte verification, and commit only the two new files. Commit observed: `1732acccb798e6edd9626fbfde38e3aca941ce4a`.

Observed worker tool output:

> CompleteGoal
> Sign-off accepted. Goal ticked [x] in
> .pi/plan/01a0831d-38ca-76db-b91a-ef4dd0bfecdd-v2.md.

Observed final supervisor response:

> Complete. Supervisor approval and CompleteGoal sign-off are recorded.

Independent parent `od -An -tx1 hello-again.txt` output:

```text
48 65 6c 6c 6f 20 61 67 61 69 6e 2e 0a
```

This is the requested text and final newline. Verification artifact: `/tmp/pi-goals-herdr-functional-task/verify-hello-again.log`.

## Behavior observed

The worker manually ticked the goal before sign-off. The widget displayed `claimed complete; awaiting supervisor review` and supervision remained connected. The supervisor read the actual artifact, verification log and plan, then directed the worker to reopen the goal checkbox. The worker reopened it, preserving evidence. The supervisor recorded approval and instructed CompleteGoal. The worker called it successfully. Parent did not supply these corrective instructions or perform the artifact work in this second run.

## Earlier failures and interventions

The first task stopped for three routine confirmations because the planning prompt required three questions. Parent answered and removed that quota with subsequent user approval. Ready opened a supervisor, but the separate 20k startup compaction threshold caused `Nothing to compact (session too small)`. Parent removed that lower threshold and reloaded the test supervisor. The first run produced its artifact but manual ticking detached supervision before approval; it was NOT successful workflow acceptance.

The first run also showed approval attempts against older queued views. Error text now distinguishes a disconnected worker from a newer pending view and directs the supervisor to finish its response to receive the update rather than request another handoff. The second task reached Ready without routine confirmations and completed without parent repair after Ready.

## Source records

- Worker: `/home/code/.pi/agent/sessions/--tmp-pi-goals-herdr-functional-task--/2026-09-08T22-22-05-515Z_01a0831d-38ca-76db-b91a-ef4dd0bfecdd.jsonl`
- Successful supervisor: `/home/code/.pi/agent/sessions/--tmp-pi-goals-herdr-functional-task--/2026-09-08T22-57-20-349Z_01a0833d-7ddd-7523-92b3-0560f61dbc64.jsonl`
- Failed first supervisor: `/home/code/.pi/agent/sessions/--tmp-pi-goals-herdr-functional-task--/2026-09-08T22-26-54-633Z_01a08321-a229-70ad-9007-cba97aef7072.jsonl`

## Limits

This proves one real trivial workflow, including visible corrective supervision of a manual tick, artifact delivery and sign-off. It does not establish broad judgment quality or cost savings. Idle external-plan edits, active worker reload recovery, all-cancelled handling, and requested `/goals supervise` and `/goals noplan` still require acceptance. Those commands are not implemented yet. Test panes were left available for inspection. Two old dirty native-evidence files remain untouched and are unrelated to this evidence.
