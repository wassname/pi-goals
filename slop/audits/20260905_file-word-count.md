# Git-tracked text files by word count

Definition: a tracked entry is text when it is a regular file, decodes as strict UTF-8, and contains no NUL character. A word is one non-empty run separated by Unicode whitespace (`len(text.split())`). Counts sort descending, then paths sort ascending.

Generation commands:

```sh
git add slop/audits/20260905_file-word-count.md
uv run /tmp/pi-goals-wordcount-generate.py
uv run /tmp/pi-goals-wordcount-verify.py
```

| file | words |
| --- | ---: |
| `package-lock.json` | 6025 |
| `src/index.ts` | 3965 |
| `docs/spec/2026-06-15_pi-goals.md` | 2869 |
| `test/goals-flow.test.ts` | 2757 |
| `src/prompts.ts` | 2022 |
| `src/worker.ts` | 833 |
| `docs/reviews/pi-goals-kimi-k3.md` | 823 |
| `docs/slop/plans/20260826_pi-plan-aligned-planning.md` | 814 |
| `README.md` | 803 |
| `scripts/inconclusive-fail-forward.diff` | 719 |
| `docs/spec/2026-06-29_complete-goal-fail-forward.md` | 705 |
| `docs/reviews/goals_menu2.md` | 698 |
| `src/supervisor-runtime.ts` | 673 |
| `docs/spec/2026-08-14_per-session-plan.md` | 664 |
| `docs/reviews/review.md` | 539 |
| `test/supervisor-runtime.test.ts` | 529 |
| `test/rpc-review.test.ts` | 517 |
| `test/worker.test.ts` | 504 |
| `src/approval.ts` | 439 |
| `slop/plans/20260905_goal-steward.md` | 410 |
| `docs/slop/plans/20260706_plan-flow-and-judge-review.md` | 403 |
| `docs/reviews/pi-goals-grok-4-6-retry.md` | 386 |
| `slop/audits/20260905_file-word-count.md` | 373 |
| `docs/reviews/goals_menu2_r2.md` | 367 |
| `scripts/check-judge-footprint.sh` | 305 |
| `test/fold.test.ts` | 273 |
| `slop/audits/20260905_nested-supervisor-validation.txt` | 272 |
| `slop/audits/20260905_goal-steward-validation.md` | 246 |
| `slop/audits/20260905_pi-goals-line-count-table.md` | 239 |
| `scripts/stale-fixme-removal.diff` | 237 |
| `test/prompts.test.ts` | 207 |
| `docs/slop/audit/20260826_pi-plan-aligned-planning.md` | 186 |
| `agents/goal-worker.md` | 161 |
| `AGENTS.md` | 159 |
| `test/tick-goal.test.ts` | 157 |
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

- tracked entries: 48
- text files/table rows: 47
- excluded non-text entries: 1 (`media/screenshot.png`)

Independent verification output:

```text
tracked entries: 48
text files/table rows: 47
excluded non-text entries: 1
file-set mismatch: 0
count mismatch: 0
order mismatch: 0
PASS
```

The independent verifier reads `git ls-files` again, uses `re.finditer(r"\S+", text)` instead of `split()`, parses this table, and compares the full ordered `(path, count)` sequence.

-- PI[gpt-5.6-sol]
