import { describe, expect, it } from "vitest";
import { foldPlan, openSubtasks } from "../src/index.js";

const plan = `# Plan

## User voice

- > "keep it under 50 lines"

## Goals

1. [/] goal: Implement the cache layer
  - discriminator: hit-rate > 0.8 in load-test.log
  - tasks:
    1. [x] wire client
    2. [/] eviction policy
    3. [ ] bench p95
2. [ ] goal: Ship the docs
  - tasks:
    1. [ ] write the readme

## Log
- 2026-08-05 12:00  wired the client

## Learnings
- the tokenizer pads left, which silently shifted every offset

## Appendix (context, not approved)
${"filler line\n".repeat(200)}`;

describe("foldPlan (the working set is what gets re-sent; below ## Log is durable memory)", () => {
	it("keeps the title, user voice and goals", () => {
		const folded = foldPlan(plan);
		expect(folded).toContain("keep it under 50 lines");
		expect(folded).toContain("goal: Implement the cache layer");
		expect(folded).toContain("discriminator: hit-rate > 0.8");
	});

	it("drops the log, the learnings and the unlimited appendix", () => {
		const folded = foldPlan(plan);
		expect(folded).not.toContain("wired the client");
		expect(folded).not.toContain("tokenizer pads left");
		expect(folded).not.toContain("filler line");
		expect(folded.length).toBeLessThan(plan.length / 4);
	});

	it("returns the whole plan when there is no ## Log yet (a fresh draft)", () => {
		const draft = "# Plan\n\n## Goals\n\n1. [ ] goal: do the thing\n";
		expect(foldPlan(draft)).toBe(draft.trimEnd());
	});
});

describe("openSubtasks (the widget shows the next action, so the plan IS the task list)", () => {
	const active = plan.split("\n").findIndex((l) => l.includes("goal: Implement the cache layer"));

	it("lists the active goal's open and in-progress subtasks, stopping at the next goal", () => {
		expect(openSubtasks(plan, active)).toEqual(["eviction policy", "bench p95"]);
	});

	it("does not leak subtasks from the goal below", () => {
		expect(openSubtasks(plan, active)).not.toContain("write the readme");
	});
});
