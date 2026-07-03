import { describe, expect, it } from "vitest";
import { tickGoal } from "../src/index.js";

const plan = `# Plan

## Goals

1. [/] goal: Implement the cache layer
  - tasks:
    1. [x] wire client
2. [ ] goal: Ship the docs

## Log
`;

describe("tickGoal (sign-off ticks the goal; agent only ticks on wording drift)", () => {
	it("ticks the exact-matching goal line, case-insensitive, leaving subtasks alone", () => {
		const out = tickGoal(plan, "implement the CACHE layer");
		expect(out).toContain("1. [x] goal: Implement the cache layer");
		expect(out).toContain("1. [x] wire client"); // subtask untouched (was already x)
		expect(out).toContain("2. [ ] goal: Ship the docs"); // other goal untouched
	});

	it("returns null on wording drift (fuzzy matching is the judge's job, not TypeScript's)", () => {
		expect(tickGoal(plan, "Implement caching")).toBeNull();
	});

	it("returns null when the subject matches more than one goal line", () => {
		const dup = `${plan}3. [ ] goal: Ship the docs\n`;
		expect(tickGoal(dup, "Ship the docs")).toBeNull();
	});
});
