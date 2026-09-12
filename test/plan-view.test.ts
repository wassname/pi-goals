import { expect, it } from "vitest";
import { planViews } from "../src/plan-view.js";

it.each(["", "  "])("ignores %sindented identity bookkeeping and Log edits, but reviews tasks and goals", indent => {
	const base = `# Plan\n- [ ] goal: result\n  - tasks:\n    - [ ] run it\n${indent}- worker session: /saved.jsonl\n## Log\nfirst entry`;
	const view = planViews(base).notify;
	expect(planViews(base.replace("/saved.jsonl", "/moved.jsonl")).notify).toBe(view);
	expect(planViews(base.replace("first entry", "second entry")).notify).toBe(view);
	expect(planViews(base.replace("- [ ] run it", "- [x] run it")).notify).not.toBe(view);
	expect(planViews(base.replace("[ ] goal: result", "[x] goal: result")).notify).not.toBe(view);
});

it("uses Log as the boundary even when Interview precedes Goals", () => {
	const plan = "# Plan\n## Interview\nOriginal discussion\n## Goals\n- [ ] goal: output\n### Log\n- [ ] goal: archived";
	const view = planViews(plan).notify;
	expect(view).toContain("goal: output");
	expect(view).not.toContain("archived");
	expect(planViews(plan.replace("goal: output", "goal: changed output")).notify).not.toBe(view);
});
