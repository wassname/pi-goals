# Isolated real Herdr / pi-subagents lifecycle trial

**Verdict: mixed; reload is a release blocker.** This was one bounded, real interactive Pi worker trial using candidate `edxeth/pi-subagents` `953c6f6d2fc7d8a5c956c30cd77c51bad697c2a4` (v2.9.0), a real parent on `openai-codex/gpt-5.6-terra`, and a real worker on `fireworks/accounts/fireworks/models/deepseek-v4-flash-0731`. No source, user config, install, global setting, or credential content was changed or printed.

## Isolation and setup

- Confirmed `HERDR_ENV=1`; read `/home/code/.pi/agent/skills/herdr/SKILL.md` and ran `herdr --skill`.
- Herdr server: 0.9.0, protocol compatible.
- Created only my own isolated workspace `w9`, root parent pane `w9:p1`, and candidate-created worker pane `w9:p3`.
- Isolated repo/profile: `/tmp/pi-goals-edxeth-lifecycle-20260910-094807-460795/{repo,profile}`. The profile loaded only the candidate's local `src/index.ts`; `auth.json` was a symlink to the existing auth file and was never read or copied. No test action was sent to `w8:p62`, `w8:p63`, or `w8:p64`.
- Worker definition used `mode: interactive`, `async: true`, and `auto-exit: false` to test the requested normal, directly interactive worker UI.

## Observed results

### Positive evidence

1. **Full interactive worker surface opened.** Candidate created `w9:p3`, labeled `[trial-worker] Isolated worker artifact`; Herdr detected it as a normal `pi` agent.
2. **Tiny deliverable existed and was independently byte-checked.** The worker created:
   - `worker-artifact.txt`: exact bytes `WORKER_ARTIFACT_OK\n` (SHA-256 `e2a7ca7c72b07fb50b7862a4f4fe46f50c70110cca91762f064ba30769ce7cdd`)
   - `worker-verification.txt`: exact bytes `VERIFIED_WORKER_ARTIFACT_OK\n` (SHA-256 `48f1324e44b69148509929d074000414c117f70a992f5b3d3c304b2fad00fc4f`)
3. **Direct worker messaging worked.** I sent `DIRECT_WORKER_MESSAGE` directly to `w9:p3`; the worker visibly acknowledged the clarification, read both files, and made its final verification in that normal worker pane.
4. **Worker `/model` picker worked.** The visible worker UI showed the model chooser, including the checked worker model, the parent default, `(1/517)`, `Model catalogs refreshed.`, and `Enter to select · Ctrl+S to set as default · Escape/Ctrl+C to cancel`. I closed the picker with Escape without changing a model.
5. **Worker cancellation worked through normal UI.** On a real read-only worker turn, `Escape` produced the visible `Operation aborted`. The child session records an assistant message with `stopReason: "aborted"` and `errorMessage: "Operation aborted"`. (Earlier `Ctrl+C` attempts did not cancel because Pi's own rendered help specifies Escape as the working-turn interrupt; this is why the successful capture uses Escape.)
6. **Manual worker stayed open after a natural task completion.** After its final verification, `w9:p3` remained open and idle. The parent widget still showed `Agents · 1 running` and the worker's final verification, proving the surface did not silently exit.

### Gaps / failures

1. **No automatic parent verification while the manual worker remained open.** The worker naturally finished the bounded artifact task and remained available as configured. Before reload, the parent transcript showed only the launch and one running worker; it did not receive a subagent result, read either file, or report validation. This is consistent with the current manual lifecycle implementation: its interactive watcher waits for pane/process completion, not merely a final assistant message. It does not meet the requested combination of an open normal worker pane and automatic parent read/verification.
2. **`/reload` with the idle-open worker is a hard failure.** I sent `/reload` to the idle parent without manually closing the worker. Within two seconds, candidate shutdown closed `w9:p3`, then the parent Pi exited to its shell with:

   ```text
   pi exiting due to uncaughtException:
   Error: This extension ctx is stale after session replacement or reload.
   ...
   at SubagentWidgetManager.update (.../src/runtime/widget.ts:139:24)
   at updateWidget (.../src/runtime/wiring.ts:72:24)
   at .../src/runtime/running-registry.ts:255:5
   ```

   This was **not** an intentional worker-pane close; `/reload` caused it. The parent did not automatically verify the artifacts before crashing. The worker trace records `session.shutdown` with one running child, followed by `interactive.watch.error ... "Aborted"`.

## Smallest unpatched candidate suggestion

Do **not** apply this in this trial. The crash follows the reload shutdown path:

- `shutdownSubagentsForParentExit()` sets `running.allowSteerDelivery = false`, aborts the worker watcher, clears the registry, and resets the widget.
- The aborted watcher rejects into `wireSubagentSteerBack()`'s `catch` in `src/runtime/running-registry.ts` (around line 252).
- That catch unconditionally calls the stale closure's `updateWidget()` (line 255), then would use stale `pi.sendMessage`.

The smallest targeted candidate patch to investigate is a guard immediately after the cleanup in that `catch`:

```ts
releaseSpawnWidthSlot(running);
runningSubagents.delete(running.id);
if (running.allowSteerDelivery === false) return;
updateWidget();
```

The shutdown already resets the widget and marks delivery detached, so the guard prevents a shutdown/reload-aborted watcher from touching stale UI or delivering a false late result. Add a focused reload-with-idle-manual-interactive-child regression test before accepting it. The separate product/lifecycle question remains: if parent auto-verification while a manual worker pane remains open is required, the watcher needs a distinct first-final-message delivery path that does not close the interactive surface; merely fixing the stale-context crash will not add that behavior.

## Captures and reproducibility

All textual and ANSI captures, exact command sequence, trace, and status are under:

- `/tmp/pi-goals-edxeth-lifecycle-20260910-094807-460795/captures/`
- Trial repo: `/tmp/pi-goals-edxeth-lifecycle-20260910-094807-460795/repo`
- Trial profile/sessions: `/tmp/pi-goals-edxeth-lifecycle-20260910-094807-460795/profile`
- Candidate trace: `/tmp/pi-goals-edxeth-lifecycle-20260910-094807-460795/subagent-trace.log`

Most useful files:

- `captures/child-completion-final.txt` / `.ansi` — direct-message acknowledgement, final verification, idle-open UI.
- `captures/worker-model-picker-retry-final.txt` / `.ansi` — actual model picker.
- `captures/worker-escape-cancel-after.txt` / `.ansi` and `captures/child-session-tail.jsonl` — successful Escape cancellation evidence.
- `captures/parent-before-reload.txt` — parent still shows the worker running, without automatic parent validation.
- `captures/parent-reload-final.txt` / `.ansi`, `captures/panes-parent-reload-2.json`, and `captures/trace-tail.txt` — reload closes worker and crashes parent.
- `captures/commands-run.txt`, `captures/final-status.txt`, and `captures/workspace-create.json` — exact commands/IDs/revisions/status.

Manual interventions were limited to the requested direct worker message, opening/cancelling the worker model picker, Escape cancellation of a real read-only turn, and the requested parent `/reload`. No artifact was manually created; no post-result parent nudge was sent; no alternative executor was used.

## Cleanup and repository safety

After captures, only workspace `w9` (created for this trial) was closed intentionally. Its closure is cleanup, not evidence of the reload defect. Candidate checkout remained clean. The governed main checkout remained dirty as supplied and had no staged files; final status also showed an unrelated untracked `.local/runtime-recovery/20260910-reviewer-followup/` tree that was not touched by this trial.

```acceptance-report
{
  "criteriaSatisfied": [
    {
      "id": "criterion-1",
      "status": "satisfied",
      "evidence": "No implementation scope was widened: the trial used one isolated temporary repo/profile, exactly one candidate worker, and no source/config/package edits."
    },
    {
      "id": "criterion-2",
      "status": "satisfied",
      "evidence": "Absolute capture paths, command sequence, revisions, session paths, UI transcripts/ANSI captures, artifact hashes, trace, exact reload stack, and an unpatched minimal patch suggestion are recorded above."
    }
  ],
  "changedFiles": [
    "/home/code/.pi/agent/sessions/--home-code-.pi-agent-git-github.com-wassname-pi-goals--/subagent-artifacts/outputs/a4cfba28-bc8d-4869-872b-f43689d3fd39/validation/interactive-lifecycle.md"
  ],
  "testsAddedOrUpdated": [],
  "commandsRun": [
    {
      "command": "HERDR_ENV=1; herdr --skill; herdr status",
      "result": "passed",
      "summary": "Herdr environment confirmed and compatible server observed."
    },
    {
      "command": "isolated Herdr workspace + native interactive Pi parent + one candidate worker",
      "result": "passed",
      "summary": "Real worker UI, direct message, artifact, model picker, and Escape cancellation were observed."
    },
    {
      "command": "parent /reload with idle-open worker",
      "result": "failed",
      "summary": "Worker was closed and parent Pi crashed with stale extension context."
    },
    {
      "command": "git diff --cached --quiet",
      "result": "passed",
      "summary": "No staged files in the governed checkout."
    }
  ],
  "validationOutput": [
    "Worker artifacts byte-verified with recorded SHA-256 values.",
    "Normal worker /model picker visibly rendered; Escape cancellation recorded as Operation aborted.",
    "Parent did not automatically verify a naturally complete manual worker while its pane remained open.",
    "Reload regression reproduces an uncaught stale-context exception."
  ],
  "residualRisks": [
    "Reload is not safe with an idle-open interactive manual worker.",
    "Open manual worker panes do not currently deliver natural completion to the parent for automatic verification.",
    "Main checkout was already dirty; final status also showed an unrelated untracked .local/runtime-recovery tree that was not touched."
  ],
  "noStagedFiles": true,
  "diffSummary": "No source diff; managed validation report only.",
  "reviewFindings": [
    "blocker: src/runtime/running-registry.ts:255 - reload-aborted interactive watcher calls stale updateWidget and crashes parent Pi.",
    "gap: manual interactive worker final output remains undelivered while pane stays open, so parent auto-verification does not run."
  ],
  "manualNotes": "Created only w9 and w9:p3, then captured results. No user-reserved pane was sent input or closed."
}
```