# Single-package and role-model validation

2026-09-07. The parent accepted the implementation after independent review and a targeted recheck. Changes are in the local pi-goals feature worktree; this is not an npm release.

## Delivered

- One pi-goals package: internal supervisor, bundled Intercom/VCC, and one package-root supervisor launch. Herdr remains the terminal host.
- Separate remembered planning, worker and supervisor provider/model choices. Files are under `getAgentDir()/pi-goals/`; the fresh evidence-judge override stays separate.
- At least three task-specific alignment questions by default. An explicit affirmative current-plan waiver skips them; negations and quoted feature names do not.
- Ready / Discuss / Edit / Cancel. Discuss and Escape preserve the draft and return to chat. `RequestPlanReview` reopens review when discussion is finished, including an unchanged draft. Only Ready starts work.

## Observed validation

[Saved full output](evidence/2026-09-07_single-package-final-validation.log) contains:

```text
 Test Files  12 passed (12)
      Tests  67 passed (67)
...
ℹ tests 118
ℹ pass 118
ℹ fail 0
ℹ skipped 0
...
SINGLE_PACKAGE_FINAL_VALIDATION_PASSED
```

`npm test` includes the packed/extracted production artifact running two real Pi sessions, the actual bundled Intercom broker and an offline fresh judge. It checks distinct actual role models and does not load a companion source checkout. The real-Pi conversational test covers Discuss and same-current-model recovery. Herdr is mocked in automated tests. Typecheck, lint, build and diff checks passed. Comparing common entries in the old/new lockfiles found no changed versions of existing locked packages.

The first review found four defects: stop blocked by model unavailability; activation before worker restoration and wrong recovery role; negated waiver matching; and same-model selection not triggering recovery. All were fixed with regressions. Parent inspection also caught a recovery await before cancellation ownership was captured; two more regressions cover clear/replacement during that await. The targeted review read current source and tests and returned `No issues found.` and `Merge verdict: OK`.

## Migration and remaining limits

The parent removed the two old companion entries from the user's Pi package list after the packed path passed. Only pi-goals remains registered for this workflow. Existing workers must reload before Ready: their old launch arguments still name the standalone extensions. The failed supervisor pane was observed at a shell with no Pi process; no duplicate recovery process was started during implementation.

Live Herdr recovery/navigation, the quality of questions from the user's chosen model, and token savings still need a human trial. The old historical tool-call-without-result issue can still block whole-plan `done`; `/goals clear` explicitly disconnects supervision and preserves history. This change did not weaken outstanding-work checks or alter old session transcripts.

<!-- Parent synthesis from observed commands, source inspection and review output, by Pi. -->
