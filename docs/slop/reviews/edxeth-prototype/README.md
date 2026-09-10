# Main-chat supervisor prototype: functional result

Prepared by Pi/OpenAI, 2026-09-10. Local worktree `experiment/main-supervisor-edxeth`, based on `15dd7f02225d366ae920509bb23066be83956fb8`. edxeth runtime pinned to `953c6f6d2fc7d8a5c956c30cd77c51bad697c2a4` (v2.9.0); installed Pi 0.85.1. Exact prototype source is in this commit.

## Result

The fresh real-model Herdr trial completed both goals after human Ready, without an operator message between Ready and completion. The parent stayed in its original chat and model. One interactive worker implemented the greeting, returned its report, and was resumed from the same saved session to implement the CLI. The parent inspected the files, independently reran verification and recorded both sign-offs. A separate operator rerun also passed.

This establishes a small end-to-end prototype, not general reliability, cheaper-model quality or encrypted-history compatibility of every configured extension.

## Evidence and how to read it

- [Actual worker Pi pane](worker-pane.txt): Herdr captured `▸ Agent greeting-worker (goals-worker)` and `gpt-6-astra  Github Copilot  minimal`, including Pi's input editor/footer in pane `w1:p19`. This is an interactive process, not a transcript viewer. The trace ties that pane to the test worker. The worker auto-closes on report; follow-up uses its saved session.
- [Sanitized fresh-session records](fresh-trial/sessions-summary.json): parent `01a08905-7913-71a3-8214-e415587da48f` calls `subagent`, `CompleteGoal`, `subagent_resume`, `CompleteGoal`. Launch and resume refer to the same file ending `9fa3d5f1-7af456e5-363beba6-1319.jsonl`. The child writes `greeting.txt` and `count.mjs`; the parent edits the plan and runs its own evidence checks, not the implementation. The first launch attempt invented an unavailable model override (`edxeth/minimax-m2.7`); the parent corrected that error itself. The successful trial used the configured Copilot model for both roles, so no cost/quality comparison is claimed.
- [Final rendered parent](final-parent.txt): `goals: supervising | 2/2 reviewed` and both checked goal labels are visible. The report says `The same worker session handled both goals sequentially.`
- [Completed plan](fresh-trial/plan.md): contains exactly the two requested goal subjects and parent observations referencing the actual artifacts and saved checks. No Git cleanliness gate is involved; evidence was ignored.
- [Greeting](fresh-trial/greeting.txt) and [independent byte check](operator-check/greeting.json): the operator observed `{"pass":true,"bytes":13,"hex":"68656c6c6f20776f726b65720a"}`. Full byte equality, not only file size, was asserted.
- [CLI](fresh-trial/count.mjs) and [operator rerun](operator-check/count.stdout): `PASS: all 9 cases` follows greeting, empty, UTF-8, binary, spaces, missing arguments, extra arguments, nonexistent file and unreadable file checks. Per-case streams/status and an actual UID/read-denial record are saved beside it. The verifier source is in `fresh-trial/verification/verify-count.mjs`; it asserts stdout, stderr and exit separately and proves EACCES instead of assuming chmod denies root.
- [Copied native-history replay](copied-replay.txt): `"passed":true,"requests":3,"network":0,"contextHooks":0,"readyRole":"supervising","snapshotUnchanged":true`. `prototype/replay-smoke.mjs` makes a further temporary copy of the previously copied JSONL; it tests planning → Ready → saved post-compaction notice with Pi's actual runtime and unchanged native replay guard. Model output is deterministic, and compaction notification is simulated. It does not run a new live compaction or load a research session.
- [Package validation](npm-test.txt): `Tests  128 passed (128)`. Typecheck, lint and diff check also passed. These support the functional evidence; they do not substitute for it.

Raw sessions and private auth copies stay under `/tmp/goals-edxeth-trial-6r8lwu`. Only task-local sanitized records and artifacts are stored here. No research JSONL, provider response IDs or credentials are included.

## First trial and corrections

The first trial (`/tmp/goals-edxeth-trial-PjLvDi`) completed both goals only after operator interventions; [records](first-trial/sessions-summary.json) are retained separately. Do not count it as autonomous success.

1. The copied normal profile lacked extension-specific sandbox configuration. A skill read prompted for permission. The operator disabled sandbox for this authorized isolated trial. Reload later re-enabled it, and a verification command failed before execution because `apply-seccomp` was unavailable. The fresh trial uses the explicitly requested `--no-sandbox` startup flag for parent and worker; this does not change global policy.
2. The first prototype used `sendMessage(triggerTurn:true)` for Ready. Pi 0.85.1 routes that through `_runAgentPrompt` without `before_agent_start`; the prior planning system prompt could remain active. The parent stopped after goal one. The fix uses a saved `sendUserMessage` prompt for phase transitions, which prepares the current role. The copied-runtime test checks the actual system prompt and replay acceptance. The corrected fresh trial continued automatically to goal two.
3. Parent `/reload` retained the first signed-off goal, approved mode and worker session. The operator then asked it to continue; edxeth resumed that same worker and the parent eventually signed off goal two. Reload after fresh-trial completion also retained `2/2 reviewed` (see [capture](reload-completed.txt)). This does not prove reattachment during a live child run or after a crash.
4. Herdr's external agent status remained stale enough that two `agent prompt --wait` calls returned `agent_prompt_stalled` even though the pane had progressed. We inspected the rendered pane and session, rather than treating that wrapper result as task failure. The event-driven capture recorded the first worker; the initial observer did not recognize edxeth's resume trace event. Its source now handles both launch and watch-start and treats pane IDs as opaque. No second-worker screenshot is claimed.

## Remaining limits

- Stop/exit persist the local state and request `subagent_kill`; remote termination is explicitly unconfirmed until observed. The prototype does not claim a new lossless stop/reconnect protocol.
- Parent crash, parent reload while a worker is active, live child reload, and a lost launch receipt need separate functional checks. Do not silently launch a replacement writer when state is uncertain.
- The worker is a full interactive Pi while it runs, but auto-exit closes the pane after its report. Manual lifecycle leaves it open at the cost of different report/closure behavior. That trade-off needs user feedback.
- Approval is a recorded parent judgment with real evidence references, not an independent fresh judge. File existence is not semantic verification. Changes to evidence/requirements after sign-off still need human/supervisor re-review.
- Supervision happens at task/goal handoffs. There is no periodic VCC view during a long worker run. Explicit timeout/idle policies are intentionally not invented by this prototype.
- Normal packages were retained except conflicting goals/subagent packages, but isolated top-level configuration copies do not reproduce every extension-specific sidecar setting. Global installation and running research sessions were not changed.
