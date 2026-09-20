import { expect, it } from "vitest";
import { planViews } from "../src/plan-view.js";

it.each(["", "  "])("separates passive %sindented bookkeeping from material plan changes", indent => {
	const base = `# Plan\n- preferred worker model: fast/model\n- [ ] goal: result\n  - discriminator: output is readable\n  - tasks:\n    - [ ] run it\n  - evidence:\n    - old.log\n${indent}- worker session: /saved.jsonl\n## Log\nfirst entry`;
	const views = planViews(base);
	expect(planViews(base.replace("/saved.jsonl", "/moved.jsonl"))).toEqual(views);
	expect(planViews(base.replace("first entry", "second entry"))).toEqual(views);
	const task = planViews(base.replace("- [ ] run it", "- [x] run it"));
	expect(task.activity).not.toBe(views.activity);
	expect(task.notify).toBe(views.notify);
	const evidence = planViews(base.replace("old.log", "new.log"));
	expect(evidence.activity).not.toBe(views.activity);
	expect(evidence.notify).toBe(views.notify);
	expect(planViews(base.replace("[ ] goal: result", "[x] goal: result")).notify).not.toBe(views.notify);
	expect(planViews(base.replace("output is readable", "output is legible")).notify).not.toBe(views.notify);
	expect(planViews(base.replace("fast/model", "strong/model")).notify).not.toBe(views.notify);
});

it("uses Log as the boundary even when Interview precedes Goals", () => {
	const plan = "# Plan\n## Interview\nOriginal discussion\n## Goals\n- [ ] goal: output\n### Log\n- [ ] goal: archived";
	const view = planViews(plan).notify;
	expect(view).toContain("goal: output");
	expect(view).not.toContain("archived");
	expect(planViews(plan.replace("goal: output", "goal: changed output")).notify).not.toBe(view);
});
