import { expect, it } from "vitest";
import { planViews } from "../src/plan-view.js";

it("keeps outcome, preferences and discriminators without tasks or history", () => {
	const plan = "# Outcome\nBeat random, not just plot it.\n## User preferences\nKeep costs low.\n## Goals\n1. [ ] goal: repair\n  - discriminator: beats random\n  - subtle failure mode: plot exists but result fails\n  - tasks:\n    1. [x] draw plot\n  - evidence:\n    - old output\n2. [ ] goal: confirm\n## Task list\n- [ ] run it\n## Appendix\nunapproved idea";
	const views = planViews(plan);
	for (const text of ["Beat random", "Keep costs low", "goal: repair", "discriminator: beats random", "subtle failure mode", "goal: confirm"]) expect(views.short).toContain(text);
	for (const text of ["draw plot", "old output", "run it", "unapproved idea"]) expect(views.short).not.toContain(text);
	expect(views.long).toContain("draw plot");
	expect(views.long).toContain("old output");
	expect(views.long).not.toContain("unapproved idea");
});

it("omits only named worker identity fields from review while retaining them in full context", () => {
	const base = "# Plan\n- preferred worker model: provider/model\n- [ ] goal: result\n  - discriminator: exact bytes";
	const metadata = "\n- Active worker: worker-1\n- worker session: /saved.jsonl\n- worker intercom session: uuid";
	expect(planViews(base + metadata).short).toBe(planViews(base).short);
	expect(planViews(base + metadata).long).toContain("/saved.jsonl");
	expect(planViews(base.replace("exact bytes", "approximate match")).short).not.toBe(planViews(base).short);
	expect(planViews(base.replace("[ ]", "[x]")).short).not.toBe(planViews(base).short);
});

it("stops at history and preserves a manual goal tick", () => {
	const view = planViews("# Plan\n1. [x] goal: result\n## Log\n1. [ ] goal: historical");
	expect(view.short).toContain("[x] goal: result");
	expect(view.long).not.toContain("historical");
});
