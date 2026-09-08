# One package, remembered role models, and conversational plan alignment

The user wants supervision inside pi-goals, with a separate remembered model choice for planning,
working and supervising. This replaces the three-extension installation described in the earlier
integration plan. Two follow-up requests require default alignment questions and a clear return to
normal chat from review; the parent supplied these approved additions during implementation.

## User-visible result

Install only pi-goals, discuss a plan and select Ready to open its real supervisor. Each role restores
its last explicitly selected provider/model. Planning asks at least three task-specific alignment
questions by default. Discuss returns the review menu to ordinary conversation without an editor or
an immediately recurring menu; Ready remains the sole handoff to work.

## User voice

- > did you do the part where the last model choice in plan ,vs worker vs supervisor mode is sticky?
- > ok implement. and just put it into pi-goals I guess... seems messy to have a sep package. one clean package
- > note I tried it in another window and it didn't grill me even one quesiton that is bad should be default to at least ask 3 questions to see how far apart in understanding user and agent are
- > and then I wans't sure what to press, edit? no. refine? that's a special prompt. how to go back to chat about plan and ask it to grill. should not have ot

## Goals

1. [x] goal: Install one package for planning and supervision
   - scope: Move supervisor code and regression coverage into pi-goals. Bundle the existing Intercom transport through supported Pi packaging; no separate companion registration or source checkout required. Keep Herdr as the terminal host.
   - failure modes: A source-checkout test hides missing packed dependencies; duplicate extension registration; lifecycle regressions during the move.
   - discriminator: A packed pi-goals artifact alone supplies both real Pi sessions and completes the offline supervised-goal test. Full inherited supervisor regressions run from this repository.
   - evidence: `src/internal/supervisor/` imports the implementation from `145c2cb081f85c08b0244c4a2c8a2d9aef8debda`; `THIRD_PARTY_NOTICES.md` and source attribution retain provenance/MIT notices. `package.json` bundles locked Intercom 0.10.0 and VCC 0.5.0; its manifest loads Intercom through `node_modules/`, while VCC remains a compiler rather than a loaded extension. Launch passes only the pi-goals package root. Duplicate registry diagnostics reject ambiguous plan bootstrap. `test/rpc-supervisor.test.ts` packs/extracts outside companion checkouts, runs actual Pi/Intercom and an offline fresh judge, and asserts production resources and no bundled Pi core peers. Only the worker's Herdr exec is adapted; the supervisor loads the untouched extracted manifest. Parent full validation passed 59 Vitest tests and 117 internal tests (116 inherited plus duplicate-registry coverage), zero skipped.
2. [x] goal: Restore the last model selected for each role
   - scope: Remember provider/model separately for planning, worker and supervisor in user-scoped pi-goals preferences. First use inherits the current model. Preserve the separate evidence-judge override.
   - failure modes: Automatic switching overwrites another role's preference; reload/fork assigns the wrong role; one process overwrites another role's choice; an unavailable model silently changes the saved preference.
   - discriminator: Tests select distinct models in each role, enter/re-enter roles, reload and start another plan. Each role restores its own selection; missing models are reported without overwriting preferences.
   - evidence: `src/role-models.ts` uses public `model_select` (`set`/`cycle`; ignores `restore` and guarded automatic `setModel` events). Separate atomic `planning-model.json`, `worker-model.json`, and `supervisor-model.json` files under `getAgentDir()/pi-goals` contain only provider/id. Failed authentication or lookup visibly pauses the role, preserving its saved choice. `test/role-models.test.ts` covers deterministic cycling, fresh processes and unavailable/unauthenticated models. `test/goals-flow.test.ts` covers Ready, cancellation during setModel, failed Ready, next plans, fresh-instance resume/reload and inherited supervisor isolation. `test/supervisor-integration.test.ts` proves planning model capture before worker restore, supervisor model before initial compaction, activation cancellation and judge override isolation. The packed RPC flow also verifies actual planning selection and distinct worker/supervisor/judge model IDs.
3. [x] goal: Ask useful alignment questions before the final plan
   - scope: Default to at least three distinct task-specific questions in one chat round, about expected result, scope/constraints and success/failure criteria. Resolve technical facts read-only. Wait for answers and use them. Only an explicit current-objective no/skip-questions instruction waives the default.
   - failure modes: Generic ritual questions; questions skipped merely because the agent thinks it understands; an old waiver leaking into a new plan.
   - discriminator: Prompt and flow regressions require the default, persist the current-plan waiver across resync, reset it on a new plan, and keep the final-review menu closed until review is requested.
   - evidence: `src/prompts.ts` defines the default and current-plan policy; `src/index.ts` persists `questionsWaived` per plan. Prompt and flow tests cover default/waiver/next-plan behavior. The deterministic real-Pi `test/rpc-review.test.ts` asks questions before the first review, accepts chat answers, and reaches Ready. This validates protocol/control flow, not semantic question quality from every live model; no semantic question-count framework was added.
4. [x] goal: Return to ordinary plan chat from review
   - scope: Ready / Discuss / Edit / Cancel. Discuss preserves the draft and planning role, asks useful questions in chat, and supports multiple answer turns without another modal. Escape also preserves the draft and returns to chat. Edit remains direct editing; explicit Cancel discards the draft.
   - failure modes: Refine-notes editor persists under a renamed button; unchanged drafts immediately reopen the menu; discussion is lost on reload; another approval gate starts work.
   - discriminator: Discuss -> multiple chat turns without a menu -> completed discussion -> review again (including unchanged draft) -> exactly one Ready handoff. Reload retains discussion state.
   - evidence: Planning-only `RequestPlanReview` is the unambiguous signal to offer review; it does not approve work. New plans and Discuss set persisted `reviewRequested: false`. `test/goals-flow.test.ts` proves unchanged-draft re-review and reload. `test/rpc-review.test.ts` uses real Pi select/chat events and asserts no Discuss editor or premature menu. Ready still exclusively starts work.

## Log

Final parent acceptance: [saved validation and review disposition](../../reviews/2026-09-07_single-package-role-models.md). All four review findings and the recovery-cancellation correction passed the targeted recheck (`No issues found.`, `Merge verdict: OK`). Final tests: 67 Vitest and 118 internal tests, no skips. The package-list migration is complete; existing workers need reload before another Ready attempt.

## Verification

Initial (pre-review-fix) parent unsandboxed checkpoint validation, read back from
`/tmp/pi-goals-single-package-parent-validation.log`:

```text
npm test
 Test Files  12 passed (12)
      Tests  59 passed (59)
 internal node:test: tests 117, pass 117, fail 0, skipped 0
npm run typecheck: passed
npm run lint: Checked 32 files. No fixes applied.
npm run build: passed
git diff --check: passed
SINGLE_PACKAGE_PARENT_VALIDATION_PASSED
```

The full test includes production `npm pack` and the real broker/offline supervised flow, without an
optional integration flag or companion checkout. Worker-local validation independently passes 58
non-broker Vitest tests and all 117 internal regressions, plus typecheck/lint/build. Worker full
`npm test` fails only at Intercom startup: a minimal Unix `net.listen()` also returns `EPERM` in this
sandbox. The parent ran the unchanged enabled test outside that restriction and passed it. Do not
confuse the worker environment limitation with a skipped test or a product pass claim.

`tsconfig.build.json` maps only the four used source-only VCC API surfaces to narrow declarations,
because VCC 0.5.0 has upstream Pi-message/Intl type incompatibilities. Pi-goals source remains fully
typechecked/linted; tests execute the actual pinned VCC implementation. The inherited `node:test`
suite has its own package script and is not silently collected or skipped by Vitest.

Final production tarball, file listing, tracked-plus-new-source diff, source copies, status and
validation logs are saved under `/tmp/pi-goals-single-package-review/` for read-only review. No files
are staged. Fresh review and the targeted recheck are complete; parent acceptance is recorded above.

## Accepted review findings and narrow fixes

Parent accepted all four findings in `single-package-review-recovery.md`; the source was frozen
again for unsandboxed validation after this targeted pass:

1. **Stop while a model is unavailable:** the validated `stop` control-plane operation bypasses
   model readiness, while binding/channel checks and peer notification remain. AbortSignal review
   cancellation also works during the pause. Directives are ignored for paused/inactive or stopped
   workers. New actual-module clear/off tests and the internal wrong-binding/abort/stop regression
   prove that the old pair cannot revive work.
2. **Restore before activation and recover the right role:** Ready captures/attaches the planning
   fork, persists a pending worker recovery target, restores the worker model, then activates and
   hands off. Missing lookup/authentication returns to the review UI without activation or a
   supervisor review turn. The persisted recovery target remains worker across reload; an explicit
   selection writes worker-model.json, not planning-model.json. Both failure paths have supervised
   integration regressions; successful recovery reuses the existing fork and hands off once.
3. **Affirmative waivers only:** a small clause recognizer accepts explicit affirmative current-plan
   instructions including `no q's` and `skip q's`, but not `do not skip questions`, quoted feature
   names, or embedded quoted clauses. No general NLP parser or semantic question-count gate was added.
4. **Already-current model recovery:** `/goals model current` explicitly authenticates and saves the
   current model for the paused role. It does not depend on model_select, which Pi suppresses for
   an unchanged model. It is never automatic and does nothing if no role is paused. Unit tests
   cover failed authentication without preference replacement; real-Pi RPC proves that same-model
   selection alone cannot recover, then the explicit command safely recovers and Ready starts once.

The parent identified one cancellation gap in the initial repair: the recovery restore await was
outside Ready's controller/version ownership. It is now inside the captured lifetime/controller and
plan version/hash checks, before any launch call. Deferred recovery -> clear and -> replacement
regressions prove zero additional startup/activation/handoff and preserve the new/null state.

Worker validation on the final fix source: 66 non-broker Vitest tests and 118 internal supervisor tests pass;
`npm run typecheck`, lint (32 files), build and diff checks pass. Worker full `npm test` still fails
only at actual Intercom startup under the same sandbox Unix-socket EPERM limitation. The enabled
packed test has not been skipped or replaced. Parent unsandboxed validation of the four-fix checkpoint passed 65/65 Vitest and 118/118 internal
tests, zero skipped, plus typecheck/lint/build/diff checks; see
`/tmp/pi-goals-single-package-fixed-validation.log`, ending `SINGLE_PACKAGE_FIX_VALIDATION_PASSED`.
That full run predates the final recovery-await cancellation correction and two extra local tests.
Final parent unsandboxed validation of that correction has now passed **67/67 Vitest tests in 12
files and 118/118 internal tests, zero skipped**, plus typecheck, lint (32 files), build and diffcheck.
The read-back log is `/tmp/pi-goals-single-package-final-validation.log`, ending
`SINGLE_PACKAGE_FINAL_VALIDATION_PASSED`. Parent's targeted review subsequently returned `No issues found.` and `Merge verdict: OK`; all named fixes and their immediate regressions were checked.

Fresh complete snapshots are at `/tmp/pi-goals-single-package-fix-review/`, including a fix-only
delta against the previous review snapshot as well as the full tracked-plus-new-source diff. The
normal three-role/Discuss/RequestPlanReview flow is unchanged, and no extra normal-path approval
gate, IPC/package redesign, global setting edit, or legacy orphaned-write fix was made.

## Boundaries and remaining limits

- Sole writer in the goals worktree on `feature/persistent-steward`, based on `8e44738`; the supervisor source checkout was read-only. No commit/push/publish or global settings/auth edits.
- Only pi-goals is loaded after migration. Parent reports that the old standalone supervisor/Intercom global registrations have now been removed; existing workers remain instructed to wait for validated reload/retry guidance before Ready. Old worker code can otherwise launch old `-e` companion arguments. No panes were controlled here.
- Herdr remains the supported host. Automated tests mock its exec adapter; live navigation/rendering/recovery and measured token savings are not established by this change.
- Native fork/compaction, SUPERVISOR.md precedence, incremental VCC memory, correlated review/cancellation/recovery and default-on policy remain. The fresh evidence judge stays separate.
- The previous live trial's apparently stale unresolved-write `done` failure remains pre-existing and undiagnosed, as recorded in `docs/reviews/2026-09-07_supervisor-validation.md`. Outstanding-work safeguards were not weakened and cleanup is not claimed fixed.
- Role files avoid cross-role lost updates; concurrent explicit choices within the same role are intentionally last-write-wins. No thinking-level preferences or credentials are stored.

<!-- Implementation and parent-observed validation by Pi. -->
