# Visible Pi worker extensions

Question: can a strong main Pi session supervise a cheaper, visible worker Pi session, with prompts that can be edited as files?

## Observations

### edxeth/pi-subagents — <https://github.com/edxeth/pi-subagents>

- The README states: "Interactive children open in Herdr, cmux, tmux, zellij, or WezTerm; background children run headlessly."
- Its `Orchestrator` mode removes the parent's file and shell tools. `src/runtime/orchestrator-prompt.ts` says: "You are an orchestrator ... You do not inspect files, run commands, edit code, or perform implementation work yourself."
- Agent definitions are Markdown files in `.pi/agents/` or the global Pi agent directory. Their frontmatter contains `model`, `mode`, `tools`, and `session-mode`. Thus a project can keep its worker prompt and cheap-worker model in one editable file.
- The package requires Pi `>=0.85.0`; the observed local Pi version is `0.85.1`. Interactive Herdr placement is source-tested (`scripts/test-live-herdr-*.mjs`).
- GitHub API observation: 120 stars; 5 non-bot contributors; created 2026-04-16; latest code commit 2026-09-07; 2 open / 23 closed issues.
- Risk: this package uses the npm name `pi-subagents`, which is also the name of the installed Nicobailon extension. The two export overlapping tools. They should not be loaded together.

### giuseppecrj/pi-herdr-agents — <https://github.com/giuseppecrj/pi-herdr-agents>

- The README states: "Each child runs as a real Pi process in its own Herdr surface" and documents non-blocking result delivery, live child state, and model-bearing role files.
- This is a smaller, Herdr-only alternative. It supplies visible worker panes, but static source inspection did not find the strict delegation-only parent role that `edxeth/pi-subagents` provides.
- GitHub API observation: 18 stars; 2 non-bot contributors; created 2026-08-05; latest code commit 2026-09-09; 5 open / 40 closed issues. Its declared peers are unconstrained, although development dependencies target Pi 0.84, so Pi 0.85.1 compatibility is not directly declared.

### tintinweb/pi-subagents — <https://github.com/tintinweb/pi-subagents>

- The README documents a FleetView and a "live, auto-updating conversation" overlay with steering. This is close if one TUI view is sufficient, but it is not a separately switchable worker Pi pane.
- It supports Pi `>=0.84.0`. GitHub API observation: 1,111 stars; 27 non-bot contributors; latest code commit 2026-09-03; 54 open / 46 closed issues.

### Installed nicobailon/pi-subagents — <https://github.com/nicobailon/pi-subagents>

- The README documents `/subagents-fleet`: "browse children, read transcripts, steer a running child, or stop a run." This corrects the narrower claim that it cannot expose worker activity, but it remains an inspector/overlay rather than an independent Pi terminal surface.
- GitHub API observation: 3,518 stars; latest code commit 2026-09-09. It is already installed locally.

## Inference

`edxeth/pi-subagents` is the closest existing implementation (very probable, about 90%): it directly combines a strict main-session coordinator with an interactive real Pi worker in a Herdr pane, per-role models, and Markdown agent prompts. It is a better simplification target than adding another supervisor process to `pi-goals`.

Important gap: its parent orchestrator prompt is bundled in TypeScript, though Pi's `APPEND_SYSTEM.md` can extend it. The role prompt of the worker is directly editable as `.pi/agents/worker.md`. It does not promise a bespoke compaction policy such as "every 150k"; child sessions use Pi's native compaction plus its own context-warning policy.

Static source and metadata inspection only; no candidate was installed or executed.

-- PI[openai-codex]
