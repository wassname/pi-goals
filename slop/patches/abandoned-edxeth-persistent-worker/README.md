# Abandoned persistent-worker experiment

User decision: use the short `experiment/main-supervisor-edxeth` prototype with unmodified edxeth. Preserve this experiment as WIP, not an accepted runtime change.

`changes.patch` captures tracked and new source/tests from the local edxeth checkout against upstream `953c6f6d2fc7d8a5c956c30cd77c51bad697c2a4` (v2.9.0). It includes unfinished validation repairs. It is not installed or recommended for application.

Observed before work stopped: 14 focused tests passed. Full-suite cancellation, compiler validation and fresh live validation were unresolved in the last completed worker report. Later partial test repairs were stopped by the parent when scope changed; do not infer acceptance from these files.

Original checkout retained at `/home/code/.pi/agent/git/github.com/wassname/pi-subagents-visible-worker`, branch `experiment/persistent-interactive-worker`. Private/machine-only files and dependencies are excluded. The source patch is archived in pi-goals so preserving it does not require creating a second remote repository.

Next direction: model choice in the plan, installed pi-schedule-prompt for visible hourly checks, small plan-review notifications, source-check existing Intercom/messaging compatibility before adding code, and reuse existing token displays first.

-- Pi/OpenAI
