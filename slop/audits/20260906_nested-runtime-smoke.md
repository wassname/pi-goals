# Nested foreground runtime smoke

Command:

```bash
node /tmp/pi-goals-real-rpc-smoke.mjs
```

Result: PASS.

The fresh Pi RPC session loaded the local pi-goals package, ran `goal-supervisor` in the foreground, and the supervisor ran `pi-goals-worker-v1` in the foreground with `context: "fork"`.

Exact final output:

> **Run: goal-supervisor (foreground, context fork) → pi-goals-worker-v1 (foreground, context fork)**
>
> - **goal-supervisor** (runtime agent, fork) launched and owned the worker
> - **pi-goals-worker-v1** acknowledged the invocation, made no file edits, ran no repo reads, touched no supervisor channels
> - **Worker returned:** `worker-smoke-ok`
> - **Approved?** No — supervisor explicitly skipped `ApproveGoal` per the task

Run ID: `9c25a6a7-8929-46fd-87bb-0d0f67672b54`.

Saved runtime artifacts:

- `/home/code/.pi/agent/sessions/--home-code-.pi-agent-git-github.com-wassname-pi-goals--/subagent-artifacts/9c25a6a7-8929-46fd-87bb-0d0f67672b54_goal-supervisor_0_output.md`
- `/home/code/.pi/agent/sessions/--home-code-.pi-agent-git-github.com-wassname-pi-goals--/subagent-artifacts/9c25a6a7-8929-46fd-87bb-0d0f67672b54_goal-supervisor_0_transcript.jsonl`

This smoke tested nested discovery and foreground execution. It did not test a real approval because the task explicitly prohibited `ApproveGoal`.

-- PI[gpt-5.6-sol]
