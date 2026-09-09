# VCC worker-view change / UAT plan

Goal: improve supervisor judgment per context token by replacing raw transcript-tail extraction with the existing deterministic VCC compiler. Keep acknowledged-entry slicing, plan changes, tracked background work, and missing tool results. Preserve two recent thinking tails next to their actions. No transport or supervision lifecycle redesign.

Acceptance: pin and inspect the compiler dependency; test new-turn slicing, compaction/rewind resets, thinking/action ordering, tool arguments, extracted files/context, output omission notices and serialized byte bounds. Run full tests, typecheck, lint and build. Render old and new views from identical recorded maniworker windows, saving reproducible comparison and honest information-loss notes. The parent must perform real isolated Herdr acceptance after this handoff; no research pane interaction here.

Baseline: HEAD 8953dce, src/worker-view.ts 69 lines. Pre-existing dirty native worker/supervisor event logs and untracked docs/human_journal.md are outside scope and remain untouched/unstaged. No dependency lifecycle scripts will run.
