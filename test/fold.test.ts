import { describe, expect, it } from "vitest";
import { foldPlan } from "../src/plan.js";

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

describe("foldPlan (current goals are above ## Log; durable memory is below it)", () => {
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
