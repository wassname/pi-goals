import { expect, it } from "vitest";
import { manualReview, planChangedReview, planContext, planning, planningSeed, readyApproved, upkeep } from "../src/prompts.js";

const plan = `# Keep the user context

Make the requested output easy to inspect.

## User-visible result
A concrete artifact the user can read.

## User voice
- > "Preserve this requirement word for word."

## Goals
1. [/] goal: verify output
  - tasks:
    1. [ ] run the full check
  - evidence: proof.log

## Log
old progress report`;

it("keeps hindsight-judged user outcomes in initial and recurring planning instructions", () => {
	const seed = planningSeed("Make search useful", "/plan.md");
	for (const prompt of [seed, planning("/plan.md")]) {
		expect(prompt).toContain('"I know it when I see it"');
		expect(prompt).toContain("actual results in hindsight");
		expect(prompt).toContain("do not invent numerical gates to replace judgment");
		expect(prompt).toContain("technical deliverable nouns and verbs");
		expect(prompt).not.toContain("not an implementation task");
		expect(prompt).not.toContain("not a task label");
	}
	expect(seed).toContain("goal: <short, concrete requested outcome>");
	expect(seed).toContain("Put observable examples under verification");
	expect(seed).toContain("what distinguishes it from merely looking done");
	expect(seed).toContain("not stricter assistant-invented requirements");
	expect(seed).toContain("by the user or justified by existing evidence");
	expect(seed).not.toContain("imperative outcome");
});

it("keeps routine upkeep to its reason, goal lines and source path", () => {
	const base = upkeep("/plan.md", plan);
	expect(base).toMatch(/^\[pi-goals: reminder — upkeep\]\n/);
	expect(base).not.toContain("Preserve this requirement word for word.");
	expect(base).toContain("Eight unchanged turns");
	expect(base).toContain("/plan.md");
	expect(base).toContain("goal: verify output");
	expect(base).not.toContain("run the full check");
});

it("separates routine goal lines from active context without historical Log", () => {
	const short = planContext("supervising", "/plan.md", plan, "short");
	expect(short).toContain("unfinished or unreviewed goal lines");
	expect(short).toContain("/plan.md");
	expect(short).not.toContain("Preserve this requirement");
	expect(short).toContain("goal: verify output");

	const medium = planContext("supervising", "/plan.md", plan, "medium");
	expect(medium).not.toContain("Preserve this requirement word for word.");
	expect(medium).toContain("1. [/] goal: verify output");
	expect(medium).not.toContain("run the full check");
	expect(medium).not.toContain("proof.log");
	expect(medium).not.toContain("old progress report");

	const full = planContext("supervising", "/plan.md", plan, "full");
	expect(full).toContain("run the full check");
	expect(full).toContain("proof.log");
	expect(full).toContain("Preserve this requirement word for word.");
	expect(full).not.toContain("old progress report");
});

it("puts selected goal lines in plan-change and manual-review messages", () => {
	for (const text of [planChangedReview("/plan.md", plan), manualReview("/plan.md", plan)]) {
		expect(text).toContain("goal: verify output");
		expect(text).toContain("/plan.md");
		expect(text).not.toContain("Preserve this requirement word for word.");
		expect(text).not.toContain("run the full check");
	}
});

it("keeps approved work moving after evidence review without overriding pauses or scope approval", () => {
	const text = planChangedReview("/plan.md", plan);
	expect(text).toContain("Evidence-only edits do not revoke execution approval");
	expect(text).toContain("Continue only unfinished authorized work");
	expect(text).toContain("respect pauses and do not assume approval for changed scope");
});

it("keeps the current working set in the ready message but omits history", () => {
	const approved = readyApproved("goals-worker", "/plan.md", undefined, plan, "pi-session");
	expect(approved).toContain("Preserve this requirement word for word.");
	expect(approved).toContain("goal: verify output");
	expect(approved).not.toContain("old progress report");
});
