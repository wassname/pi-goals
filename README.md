# pi-goals

> **Experimental branch:** this checkout loads the [main-chat supervisor prototype](prototype/README.md), not the older runtime described below. It uses edxeth's interactive Pi workers in Herdr. Do not install it over a running research session. This package is marked private while the prototype is evaluated. — Pi/OpenAI

## Previous runtime (retained for comparison)

Plan in one Pi session, then do the work there while a stronger visible Pi session supervises it.

## How it works

1. `/goals <objective>` creates `.pi/plan/<session_id>-vN.md` and enters read-only plan mode.
2. Pi asks only material questions, writes the plan, and shows **Ready / Refine / Edit / Cancel**.
3. **Ready** opens a second Herdr pane. The new Pi session explicitly forks the planning session and compacts that fork.
4. The original session becomes the implementation worker. It keeps the full conversation and normal tools.
5. The fork becomes an inspection-only supervisor by instruction, with normal Pi tools and extensions available. Worker views and supervisor instructions travel over pi-intercom's extension channel, scoped to this plan pairing.
6. Ready waits for the supervisor's Intercom readiness message; the worker does not begin before the fork has compacted and started.
7. The supervisor compacts again when its context reaches 100k tokens.
8. The supervisor records a private approval only after it sees a stopped worker, no active work, a clean worktree (or an explicit inspected-state override), evidence, and saved verification output. `CompleteGoal` checks that approval against the exact plan block and Git tree before it ticks `[x]`.

The two Pi sessions are visible. You can switch to the supervisor pane and talk to it directly. Supervisor instructions are shown in full, including in collapsed tool rows; ordinary messages and emitted thinking use Pi's display settings. The supervisor is prompted to give brief progress assessments and use judgment about when to intervene.

On same-process reload, monitoring is restored without removing normal or custom tools. Views include the latest human direction, source-session path, worker model, and new messages since the last acknowledged view. They report Pi idleness and tracked process/subagent activity separately. Unavailable trackers stay unknown; unregistered detached jobs are not tracked. Approval is blocked while tracked work is active or unknown. Intercom disconnects are reported; unsent current views and unacknowledged instructions are retained in Pi session history for reconnect. Incoming review/instruction payloads are saved in a bounded inbox before presentation. A receipt is sent only when Pi emits the corresponding user `message_start`: this confirms session acceptance, not model judgment or tool execution. Pending payloads survive reload, and manual-compaction success, failure or cancellation resumes delivery after Pi is idle. Unpresented incremental views are kept separately, not overwritten. The inbox limit is 64 messages; overflow is reported without acknowledging the new message. Crashes around acceptance/persistence or extensions that transform/consume input can still require inspection and explicit reconnect; end-to-end exactly-once execution is not guaranteed. Reviews stop after all goals are completed or cancelled, and both panes remain available. These mechanics are tested; useful judgment and savings from a cheaper worker still require a representative two-model run. -- Pi/OpenAI

## Install

This branch requires Pi 0.85.1 or newer (before 1.0) and Herdr 0.7.5 or newer. Pi 0.85.1 supplies the public compaction-failure event and compaction-aware idle state used for delivery recovery. It reuses installed pi-intercom or loads its pi-intercom dependency when none is registered:

```bash
pi install npm:@wassname2/pi-goals
```

The supervisor launcher uses the normal Pi profile: it inherits the agent directory/environment and discovers configured extensions, skills, prompt templates, themes and authentication. It explicitly loads this pi-goals source and forks the planning session with the supervisor role/model. Existing Intercom is reused when registered. The repeated role instruction says to inspect and diagnose directly, but delegate changes through `SteerWorker` rather than alter shared state. **This is not an enforced sandbox:** bash, edit, write and extension actions remain available; other extensions may have their own hooks or restrictions. Planning-mode restrictions and approval checks are unchanged. A complete supervisor role/binding is saved before startup compaction and restored before worker handlers can run, including fresh-shell `pi --session <saved-file>` and stopped supervisor forks. Older bootstrap markers are migrated only when their saved pairing is recoverable; incomplete identity fails visibly rather than selecting worker mode. Full-profile Herdr behavior still needs parent-owned functional acceptance.

For a local checkout:

```bash
pi -e .
```

Run Pi from the Git repository that the plan will change. **Ready** fails if the current directory is not inside a Git repository; this prevents approval from checking the wrong repository.

## Commands

```text
/goals <objective>          create a new plan
/goals model <model>        select the visible supervisor model
/goals model                use the remembered supervisor model
/goals work                 reconnect the existing approved worker pairing
/goals supervise            reconnect from the saved supervisor session
/goals noplan               exit planning, preserving the draft without approving work
/goals clear                close the supervisor pane and disconnect the plan
```

`work` and `supervise` are role-aware recovery commands, not role conversion or new-pairing commands. Wrong or missing identities are rejected. `noplan` preserves the draft/history, leaves planning restrictions, and does not select Ready, start implementation or launch a supervisor. `/goals clear` closes the tracked pane and keeps the plan file. Starting another plan also keeps older versions.

If a required model or supervisor is unavailable, the widget says **goals paused** and implementation/sign-off tools are gated. Human input, read-only diagnosis, `/model`, and recovery commands remain available:

- `/goals reconnect` retries the remembered role model and existing supervisor binding. Worker readiness/reconnect waits allow five minutes, including an ordinary 60-second supervisor compaction, and never replace a slow or missing pane automatically. A returning peer clears the connection pause automatically; an established active worker pairing publishes a fresh current view so supervisor-only reload can resume review even when its previous view was already accepted.
- `/goals restart` explicitly closes only the tracked supervisor pane and starts a replacement for a working plan, preserving its file/version but invalidating old approvals. During planning it clears the failed pane so Ready can launch again.
- In the supervisor pane, use `/model` then `/goals supervise` (or `/goals reconnect`) to recover an unavailable supervisor model. Startup failure is reported to the waiting worker; it need not wait for the timeout to learn the cause.

Both sessions must load the updated transport for the request/reply reconnect fix; mixed-version peers are not a supported recovery configuration. Ready announces worker readiness only after its model is restored. Plan content is rechecked across startup/model-restore waits; changed content returns to review using the existing pane instead of starting different work. Clearing or leaving planning cancels its pending Ready attempt. `CompleteGoal` checks cancellation and the original binding/version after its asynchronous status lookup and before recording completion.

A new supervisor may still need up to five minutes for initial compaction. Recovery does not terminate background jobs. Planning/diagnostic command checks are guardrails, not an OS sandbox; loaded extensions and repository Git configuration must be trusted.

Model choices are remembered per project and role in `.pi/pi-goals/models/`. Use `/model` in planning, worker, or supervisor sessions to change that role's choice. Ready restores the worker choice after the planning fork is ready. An unavailable saved model stops the transition instead of substituting another. `/goals model <model>` explicitly overrides the supervisor choice for launch. -- Pi/OpenAI

## Inspected dirty-worktree approval

The supervisor can call `ApproveGoal` with `force: true` and a nonempty `reason` when preserved unrelated changes would otherwise prevent sign-off. It must inspect the changes first, not commit, reset or delete someone else's work. Force bypasses **only** cleanliness, never evidence, the current stopped view, active/unknown work, or exact goal/HEAD/tree checks.

The approval JSON stores the reason, NUL-delimited Git status, an index SHA-256 digest and per-dirty/untracked-file content SHA-256 digests (including modes, symlink targets and deletions). `CompleteGoal` requires the same state; even editing an already-dirty file without changing its status invalidates approval. Normal clean approvals behave as before. Git-ignored files and pi-goals' private plan/approval/model paths remain excluded. Dirty submodule/nested-repository directories or other unhashable paths fail closed; there is no recursive submodule override. Fingerprinting reads all included dirty/untracked bytes and can be expensive for large outputs; it does not lock concurrent writers.

A gate rejection is not automatically an experiment failure or a dependency of other authorized work. The supervisor should inspect the exact error and implementation, distinguish causes with a cheap check, and steer repairs plus safe independent progress instead of repeating an unproductive status check. -- Pi/OpenAI

## Plan format

Current goals belong above `## Log`; goal-shaped historical checklists below it are ignored by the widget, approval matching and sign-off. A goal is a checkbox line whose text starts with `goal:`:

```md
1. [ ] goal: Produce the report
   - subtle failure mode: the report exists but uses stale data
   - discriminator: the report cites the current input and the saved check confirms it
   - verify: `just verify`
   - evidence: (empty until sign-off)
```

The worker saves verification output in a nonempty repository file, adds that path to evidence, and commits it. The supervisor calls `ApproveGoal` with the inspected path; the worker then calls `CompleteGoal` with the exact goal text.

If context usage is unavailable, the supervisor warns once that its custom 100k compaction trigger cannot be checked. Pi's normal post-compaction `tokens: null` sample does not produce that warning; default auto-compaction is unchanged.

## Development

```bash
npm test
npm run typecheck
npm run lint
```

`test/intercom-broker.test.ts` checks readiness and exact message delivery through an isolated real Intercom broker. `test/rpc-review.test.ts` runs the planning review flow through Pi's real RPC protocol with a local deterministic model. The Herdr launcher and visible supervisor bootstrap have focused tests; use a real Herdr session for the final two-pane check.

-- PI[gpt-5.6-sol]
