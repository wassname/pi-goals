# Full-profile supervisor: focused implementation

## Approved scope

The user explicitly chose normal Pi extensions and tools, including bash/edit/write and custom actions, with the division of work enforced by role instructions rather than a tool denylist. This change does not grant the supervisor implementation authority: the repeated short opening directs inspection/diagnosis and delegates changes through SteerWorker. The long prompt explicitly states that this is not an enforced sandbox.

## Changes

- `src/herdr.ts`: remove only `--no-extensions`; retain explicit source extension, fork, role/binding environment, name and selected model. The inherited environment and normal Pi discovery remain intact.
- `src/supervisor-session.ts`: remove the supervisor BLOCKED_TOOLS constant, both active-tool filters, and tool_call denylist hook. No replacement hooks, per-tool reminders, approval changes or lifecycle repair.
- `src/prompts.ts`: centralize the concise instruction in the already-repeated opening, and clarify the trust boundary in long orientation.
- README/AGENTS: describe normal-profile discovery and instruction-only inspection; avoid claiming hard read-only enforcement or full lifecycle recovery.
- Tests assert bash/edit/write/intercom and custom tools survive startup, simulated reload and reconnect without resetting extension selections. The launcher retains normal discovery. The real native Pi RPC test now enables normal discovery in an isolated agent directory, auto-loads a custom inspection tool without `-e`, verifies it reaches the supervisor's model tool schema, and still observes exact SteerWorker delivery. Its worker remains deliberately isolated with `--no-extensions`.

## Sources inspected

Installed Pi documentation: `docs/usage.md` extension/resource discovery flags, `docs/extensions.md` active-tool APIs and loading, `docs/packages.md` profile scope/deduplication. Read applicable local `recommending-pi-extensions` skill for the full-permission trust boundary. No packages installed or fetched. Existing Intercom reuse/fallback code is unchanged; broker/native tests pass.

## Validation

`validation.txt` records final successful run:

```
env -u PI_GOALS_EVIDENCE_DIR -u PI_SUBAGENT_CHILD -u PI_GOALS_ROLE npm test
npm run typecheck
npm run lint
npm run build
git diff --check
```

108/108 tests in 19 files, typecheck, lint (37 files), build and diff check passed. No changes to `src/index.ts` or `src/approval.ts`; worker planning restrictions and approval checks remain intact. No supervisor BLOCKED_TOOLS, setActiveTools or tool_call enforcement remains.

## Limits and remaining acceptance

This verifies normal discovery using a deterministic local model and an isolated custom extension. It does not prove a real user's complete profile respects the role instruction. Arbitrary extensions retain their own hooks/side effects/tool policies; tools can still write if the model disregards its task. The parent still needs to run real full-profile Herdr acceptance and obtain an independent review. No panes were opened, reloaded or operated.

Issue #6 cancellation, Ready content drift, compaction delivery, fresh-shell role restoration and other lifecycle bugs are intentionally not fixed in this scoped task. Existing running supervisors retain their already-loaded profile until appropriately restarted/reloaded by their owner.

Pre-existing dirty `slop/reviews/review-fixes-native/supervisor-events.jsonl`, `worker-events.jsonl` and untracked `docs/human_journal.md` were neither modified nor staged by this task. No commits include them.
