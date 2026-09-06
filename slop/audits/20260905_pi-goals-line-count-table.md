# pi-goals tracked-text line counts

Scope: Git-tracked files at this repository snapshot. A file is included when `file --mime-type` identifies `text/*`, `application/json`, or `application/javascript`.

Excluded: `media/screenshot.png` is binary (`image/png`); `package-lock.json` is an npm-generated dependency lockfile. No other tracked files are excluded.

Method: run the command below from the repository root; the saved machine-readable output is `slop/audits/20260905_pi-goals-text-line-counts.txt`.

```sh
git ls-files -z | while IFS= read -r -d '\0' f; do case "$f" in media/screenshot.png|package-lock.json) continue;; esac; mime=$(file -b --mime-type "$f"); [[ "$mime" =~ ^text/|^application/(json|javascript)$ ]] && printf '%s\t%s\n' "$(wc -l < "$f")" "$f"; done | sort -k2
```

| File | Lines |
| --- | ---: |
| `AGENTS.md` | 24 |
| `agents/pi-goals-worker-v1.md` | 22 |
| `ARCHIVED.md` | 3 |
| `biome.json` | 23 |
| `docs/reviews/goals_menu2.md` | 65 |
| `docs/reviews/goals_menu2_r2.md` | 21 |
| `docs/reviews/pi-goals-grok-4-6-retry.md` | 30 |
| `docs/reviews/pi-goals-kimi-k3.md` | 40 |
| `docs/reviews/review.md` | 61 |
| `docs/slop/audit/20260826_pi-plan-aligned-planning.md` | 25 |
| `docs/slop/plans/20260706_plan-flow-and-judge-review.md` | 33 |
| `docs/slop/plans/20260826_pi-plan-aligned-planning.md` | 53 |
| `docs/spec/2026-06-15_pi-goals.md` | 275 |
| `docs/spec/2026-06-29_complete-goal-fail-forward.md` | 71 |
| `docs/spec/2026-08-14_per-session-plan.md` | 67 |
| `.gitignore` | 6 |
| `package.json` | 65 |
| `README.md` | 139 |
| `scripts/check-judge-footprint.sh` | 43 |
| `scripts/check-stale-fixmes.sh` | 14 |
| `scripts/inconclusive-fail-forward.diff` | 104 |
| `scripts/stale-fixme-removal.diff` | 30 |
| `slop/audits/20260905_goal-steward-validation.md` | 31 |
| `slop/audits/20260905_nested-supervisor-validation.txt` | 91 |
| `slop/audits/20260905_pi-goals-file-types.txt` | 52 |
| `slop/audits/20260905_pi-goals-line-count-table.md` | 67 |
| `slop/audits/20260905_pi-goals-text-line-counts.txt` | 50 |
| `slop/audits/20260905_steward-probe.json` | 15 |
| `slop/audits/20260906_foreground-supervisor-validation.txt` | 53 |
| `slop/audits/20260906_nested-runtime-smoke.md` | 31 |
| `slop/audits/20260906_nonchild-npm-test.txt` | 33 |
| `slop/plans/20260905_goal-steward.md` | 37 |
| `slop/reviews/2026-09-06_deepseek-v4-pro-0813_pi_goals_fragility.md` | 65 |
| `slop/reviews/20260906_foreground-worker-review.md` | 20 |
| `src/approval.ts` | 115 |
| `src/index.ts` | 736 |
| `src/prompts.ts` | 191 |
| `src/supervisor-runtime.ts` | 179 |
| `src/worker.ts` | 186 |
| `test/append-log.test.ts` | 17 |
| `test/fixtures/offline-model.ts` | 18 |
| `test/fold.test.ts` | 63 |
| `test/goals-flow.test.ts` | 596 |
| `test/package-agent.test.ts` | 23 |
| `test/prompts.test.ts` | 33 |
| `test/rpc-review.test.ts` | 116 |
| `test/supervisor-runtime.test.ts` | 153 |
| `test/tick-goal.test.ts` | 32 |
| `test/worker.test.ts` | 119 |
| `tsconfig.json` | 15 |
| **Total** | **4351** |

-- PI[gpt-5.6]
