# Main-chat supervisor prototype

Prepared by Pi/OpenAI. Not installed in the normal checkout.

This branch changes the package entrypoint to `src/prototype.ts`. Planning and supervision stay in the original chat and model. Ready asks that agent to delegate implementation through **edxeth/pi-subagents**, using its real interactive Herdr worker, automatic report and session resume. The parent keeps its normal inspection tools. There is no second supervisor, startup compaction, Intercom pairing, VCC polling or context-array mutation.

## Runtime

Pinned source: [edxeth/pi-subagents v2.9.0](https://github.com/edxeth/pi-subagents/tree/953c6f6d2fc7d8a5c956c30cd77c51bad697c2a4).
This is **not** the npm package `pi-subagents` from nicobailon. They register overlapping tools and commands; do not load both.

`prototype/agents/goals-worker.md` selects:

- Interactive, asynchronous Pi in Herdr; normal tools, extensions and skills.
- Trusted project resources and APPEND_SYSTEM inheritance, explicitly enabled.
- A clean model context linked to the parent (`lineage-only`), not a large inherited transcript. The parent supplies the approved plan/task. No compulsory compaction.
- Automatic report and exit after a goal. The worker is interactive while running; an operator can take over. Follow-up resumes the same saved session with edxeth's `subagent_resume`.
- `parent-close-policy: continue`. Closing the parent must not silently kill the worker. This is a requested launch policy, not a claim of lossless crash/reload recovery.

We deliberately do not enable edxeth's restricted orchestrator mode: our parent must inspect actual files and results.

## Isolated trial setup

Do not change existing panes, installed package paths or user settings.

1. Obtain and inspect the pinned edxeth checkout. It needs the peer dependencies listed in its package.json, compatible with installed Pi 0.85.1. For the local trial we used a read-only dependency symlink to the already installed compatible dependencies; no install scripts were run.
2. Run `node prototype/prepare.mjs /path/to/edxeth-checkout /path/to/installed/pi-package`. It creates a private temporary agent directory and Git project, copies auth/model/settings files, retains installed normal packages except the two conflicting packages, and adds this worktree plus edxeth. It prints the isolated paths. It does not launch Pi.
   For this user's authorized sandbox-off trial, append `--no-sandbox` to the preparation command. It applies the startup flag to both isolated roles, including after reload. Without that explicit flag, sandbox policy remains unchanged.
3. Create a new no-focus Herdr test pane at the printed project path. Run the printed `start.zsh` there. Do not use an existing research pane. Extension-specific sidecar configuration may need explicit trial configuration; the copied top-level settings are not a complete copy of every extension's state.
4. Use `/goals <objective>`, inspect the draft, and choose `/goals review` → Ready. `/goals ready` is explicit approval without opening the menu.
5. Observe the actual worker pane and parent report. Inspect the files and saved verification. Repeat through a second goal, using the same saved worker session. Record any intervention.

Auth copies and raw sessions are private trial files, not repository artifacts. Never commit them.

## Commands and limits

- `/goals status`: local phase, plan path and last worker session. Inspect `/subagents` for runtime liveness; we do not invent it from a stale local flag.
- `/goals stop`: persist a local pause, then ask the parent to stop the recorded worker through `subagent_kill`. The message explicitly says remote stop is not yet confirmed. New launch/resume calls are blocked while planning or paused.
- `/goals resume`: explicit authorization to continue a paused plan through the existing edxeth session. A draft still requires Ready.
- `/goals exit`: return to ordinary chat without approving a draft. The plan is retained. A recorded worker still needs confirmed termination.
- `/goals solo`: explicitly authorize direct work when no worker was recorded. It does not silently take over from a potentially live worker.
- `CompleteGoal`: records **the parent's evidence judgment**, not an independent model judge. Evidence files must exist and be nonempty; the parent must inspect what they show. Git cleanliness/tracking is not required. Manual checkbox edits remain unsigned claims. Deleted/reopened/ambiguous subjects lose their recorded sign-off.

The [functional report](../docs/slop/reviews/edxeth-prototype/README.md) records a real two-goal completion after Ready, worker-pane evidence, parent reload, and the copy-only native replay check, including failed attempts and interventions.

This is a prototype, not a replacement release. It does not have automatic active-worker rediscovery after a lost launch result, automatic parent crash recovery, or guaranteed stop acknowledgement. Reports are goal/task-boundary handoffs, not periodic VCC overviews. A fresh worker defaults to the parent's model; configure a concrete worker model in its definition if desired. Existing long-history encrypted replay still needs a copy-only compatibility check with the entire configured extension set.
