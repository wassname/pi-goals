# Git-tracked text files by word count

Definition: a tracked entry is text when it decodes as strict UTF-8 and contains no NUL character. A word is one non-empty run separated by Unicode whitespace (`len(text.split())`). Counts sort descending, then paths sort ascending.

Generation and independent verification commands:

```sh
python3 slop/audits/20260905_file-word-count-generate.py
python3 slop/audits/20260905_file-word-count-verify.py
```

| file | words |
| --- | ---: |
| `package-lock.json` | 6025 |
| `src/index.ts` | 3977 |
| `docs/spec/2026-06-15_pi-goals.md` | 2869 |
| `test/goals-flow.test.ts` | 2783 |
| `src/prompts.ts` | 2022 |
| `src/supervisor-runtime.ts` | 931 |
| `src/worker.ts` | 827 |
| `docs/reviews/pi-goals-kimi-k3.md` | 823 |
| `docs/slop/plans/20260826_pi-plan-aligned-planning.md` | 814 |
| `README.md` | 798 |
| `scripts/inconclusive-fail-forward.diff` | 719 |
| `test/supervisor-runtime.test.ts` | 714 |
| `docs/spec/2026-06-29_complete-goal-fail-forward.md` | 705 |
| `docs/reviews/goals_menu2.md` | 698 |
| `docs/spec/2026-08-14_per-session-plan.md` | 664 |
| `docs/reviews/review.md` | 539 |
| `test/worker.test.ts` | 527 |
| `test/rpc-review.test.ts` | 517 |
| `src/approval.ts` | 439 |
| `slop/plans/20260905_goal-steward.md` | 410 |
| `slop/audits/20260905_nested-supervisor-validation.txt` | 408 |
| `docs/slop/plans/20260706_plan-flow-and-judge-review.md` | 403 |
| `docs/reviews/pi-goals-grok-4-6-retry.md` | 386 |
| `slop/audits/20260905_file-word-count.md` | 377 |
| `docs/reviews/goals_menu2_r2.md` | 367 |
| `scripts/check-judge-footprint.sh` | 305 |
| `test/fold.test.ts` | 273 |
| `slop/audits/20260905_file-word-count-generate.py` | 268 |
| `slop/audits/20260905_goal-steward-validation.md` | 246 |
| `slop/audits/20260905_pi-goals-line-count-table.md` | 239 |
| `scripts/stale-fixme-removal.diff` | 237 |
| `test/prompts.test.ts` | 207 |
| `docs/slop/audit/20260826_pi-plan-aligned-planning.md` | 186 |
| `agents/goal-worker.md` | 161 |
| `AGENTS.md` | 159 |
| `test/tick-goal.test.ts` | 157 |
| `slop/audits/20260905_file-word-count-verify.py` | 149 |
| `slop/audits/20260905_steward-probe.json` | 146 |
| `package.json` | 137 |
| `scripts/check-stale-fixmes.sh` | 124 |
| `test/append-log.test.ts` | 102 |
| `test/package-agent.test.ts` | 89 |
| `slop/audits/20260905_pi-goals-file-types.txt` | 84 |
| `slop/audits/20260905_pi-goals-text-line-counts.txt` | 84 |
| `test/fixtures/offline-model.ts` | 52 |
| `biome.json` | 40 |
| `tsconfig.json` | 28 |
| `.gitignore` | 6 |
| `ARCHIVED.md` | 5 |

Generation summary:

- tracked entries: 50
- text files/table rows: 49
- excluded non-text entries: 1 (`media/screenshot.png`)

Independent verification output:

```text
tracked entries: 50
text files/table rows: 49/49
excluded non-text entries: 1 (media/screenshot.png)
file-set mismatch: 0
count mismatch: 0
order mismatch: 0
PASS
```

The verifier reads `git ls-files` again, uses `re.finditer(r"\S+", text)` instead of `split()`, parses this table, and compares the full ordered `(path, count)` sequence.

-- PI[gpt-5.6-sol]
