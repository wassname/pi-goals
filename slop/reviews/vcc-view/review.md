# VCC worker overview: implementation and replay review

## Decision and scope

Use the deterministic compiler from `@sting8k/pi-vcc@0.5.0` inside the existing worker view. No model call, copied compiler, transport/lifecycle change, new monitoring framework, or change to approval rules. Keep acknowledged-entry boundaries, compaction reset, missing-result matching, plan diff/status claims and existing managed process/subagent tracking. Add context percentage from `ctx.getContextUsage().percent`; unknown remains omitted.

`src/worker-view.ts`: **69 -> 100 lines (+31)**. Compiler declaration: **10 lines**. Caller: **+1 line**. Not fewer lines than the previous raw-tail implementation, but much smaller than transplanting the 302-line pi-supervise view plus its lifecycle. VCC itself remains an external dependency, not free code complexity.

## Dependency provenance and security

- Inspected `../pi-supervise/src/view.ts`, package manifest/lock, installed compiler and normalization/brief/extractor path. Custom last-two-thinking support is in pi-supervise's adapter, not a patched installed VCC package.
- Downloaded exact registry tarball using `npm pack @sting8k/pi-vcc@0.5.0 --ignore-scripts --pack-destination /tmp/pi-goals-vcc-package --json`.
- `diff -qr /tmp/pi-goals-vcc-package/package ../pi-supervise/node_modules/@sting8k/pi-vcc` produced no differences. This includes all installed package files, not just version strings.
- Pinned exact `0.5.0` in dependencies and lockfile. Registry: `https://registry.npmjs.org/@sting8k/pi-vcc/-/pi-vcc-0.5.0.tgz`; SHA512 integrity: `KJbOVUFbyghn6h+RD9bDXFNWkKNqpxaCpPQWceOuxMPe9ySpbEfaYnqO9CZUiCP3AFmQ5Ghnsg2B8pdKgY+0Hg==`.
- Tarball SHA1: `090e5c7cacec00b1083bf423bc08aa2d3eb9cb3a`; size 16,206,703 bytes compressed, 16,712,402 unpacked. It ships more than just the compiler. Added one package; no new transitive packages beyond already installed peers.
- Read cybersec-situational-awareness skill before fetching/installing. Used `npm install --save-exact @sting8k/pi-vcc@0.5.0 --ignore-scripts --no-audit --no-fund`. No lifecycle scripts run. Mise is installed but has no configured/installed Node version; used current project Node v22.23.2/npm rather than install another toolchain. This was not a sandboxed install.
- Runtime imports only compiler source, not the VCC extension entrypoint. The compiler pipeline is algorithmic: no network, shell, or model call.
- Local upstream clone is newer (09c4a74, 0.6.0 work); deliberately did not switch versions. This reproduces the installed reference dependency.

### Source-only package type boundary

Direct tsc traversal exposed three upstream 0.5.0 errors: `brief.ts:61,77` passes Intl SegmentData with optional `isWordLike` to a required-boolean shape, and `normalize.ts:21` compares Pi Message role with `bashExecution`, outside that union. Supervisor approved a narrow declaration for the exact compile input/output, with tsconfig path mapping just as this repo handles pi-intercom. No runtime fallback or node_modules patch. Source and built JS imports execute the real compiler in replay; tests likewise execute the real package. This declaration must be reviewed if the pinned compiler version changes.

## Replay method and result

`node slop/reviews/vcc-view/compare.mjs` loads the actual maniworker branch terminating at each recorded manisuper view's `through` ID, follows parent links (not dead branches), and recovers its last acknowledged view boundary. Both renderers receive identical entries, context, trigger and idle state. Old renderer comes from HEAD 8953dce; new source and built renderer outputs must agree. Paths, timestamps, IDs and branch SHA256 hashes are in `comparison.json`. No sessions were messaged, reloaded or edited. The source sessions remain local prerequisites to reproduce the replay; saved rendered views are reviewable without them.

| Recorded window | Old UTF-8 bytes | VCC UTF-8 bytes | Observation |
|---|---:|---:|---|
| Pilot preparation, 22:59:31 | 4,961 | 5,356 | Slightly larger, much better task signal |
| Flow implementation, 23:17:08 | 4,897 | 2,396 | About half the bytes; restores action context |
| Settled checkpoint, 00:11:07 | 1,676 | 1,840 | Slightly larger; direct test output lost |

These are bytes, **not measured token counts or realized supervisor cost savings**. Each complete serialized transport envelope is below 16KB (largest 5,655 bytes). The raw transcript and VCC brief keep the same total 5.5KB serialized content allowance; VCC splits extracted headers (1.5KB) from newest brief (4KB) when headers exist, so one cannot evict the other.

### What improves

- Pilot old view is dominated by unrelated queue-job JSON. VCC retains the decision that moralmaps deliberately suppresses think closure/EOS, so `emitted_close=0` is not evidence of natural nontermination; the narrower choice pilot/uncertainty approach; edited files/commit; recent thinking about run-card wording and saved-vector checks; actual shell commands rather than `tool: bash`.
- Flow old view is almost entirely a raw Python source tail with no useful explanation of the current action. VCC gives changed file paths, reviewed source paths, edit/read/bash arguments and the two recent thinking tails about evaluation configuration and token geometry. Existing E55 follower tracking remains unchanged.
- Checkpoint retains the claim `Test passed. Committed as c41e0f2`, extracted commit title, changed files, verification-log path, and thinking about byte identity/rubric migration. The old view had no tool arguments or thinking.

### Honest limits / evidence lost

- The checkpoint's actual `Ran 1 test ... OK` tool result is absent in VCC. Supervisor must read the retained log path before treating the worker's pass claim as evidence. The view explicitly says tool-result bodies are omitted and provides the source session path.
- VCC file lists/commits are extracted activity, not independent proof that a write or commit succeeded. Some file classifications are heuristic (`write` is reported as Modified). Full source/artifact inspection still matters.
- VCC's initial Session Goal extraction includes weak historical phrases such as `was your job killed?`, not the actual agreed research discriminator. It is an overview, not a replacement for the plan or latest human direction. Existing plan review remains separate.
- Generic `process` calls appear by name only in VCC's installed compiler; their detailed command/state is not reconstructed here. Existing live background summary still names tracked processes/subagents. Unregistered detached work remains untracked, as before.
- Older brief/tool entries can still be cut. Long paths/commands can wrap or truncate. Local `#` references index fresh messages, not session entry IDs; the label now explains this. The compiler's unavailable `vcc_recall` instruction is removed.
- Two recent thinking tails are limited to 400 characters before the compiler's own shortening; hidden/redacted thinking cannot be recovered. Large views may still cut earlier retained thinking.
- First/reset views can repeat older instructions. No new deduplication or lifecycle machinery was introduced in this scoped change.

## Validation

Final output: `validation.txt`. `npm test`: **94/94**, 18 files including RPC. Typecheck, lint, build and diff check pass. Six focused worker-view tests added to the previous three: thinking/action order and immutability; extracted paths/blockers/arguments with omitted output notices and metadata; partial pending calls across acknowledgements; rewind/compaction reset and unknown context; oversized headers/brief preserving newest activity; omitted-result versus empty-update distinction and commit extraction. Existing flow fixture supplies the new standard context-usage API.

During implementation, full tests caught a partial `edit` call with no arguments: the adapter now supplies an empty argument object for that incomplete call while preserving missing-result status. Two added assertions initially assumed VCC classified `write` as Created and could extract a commit from a result without its call; corrected tests to the inspected compiler semantics, not patched dependency behavior. Upstream type errors are isolated as described above. All final checks pass.

## Remaining acceptance

The replay supports a **better overview**, especially when raw output crowds out decisions, but not a claim that this produces better outcomes or lower total token cost. Parent-owned isolated real Herdr acceptance and independent reviewer gate remain required. Suggested UAT: trivial artifact and saved verification log; inspect the supervisor's new overview and actual artifact read; exercise a manual plan tick/edit and full ApproveGoal -> CompleteGoal sequence. Do not use the user's research panes.

No Herdr panes, GPU jobs, supervisor sessions, user research files, old native evidence logs or human journal were modified by this task. No push performed.
