import { describe, expect, it } from "vitest";
import { decideStewardSignOff } from "../src/index.js";

describe("decideStewardSignOff", () => {
	it("accepts only the steward's accept verdict", () => {
		const out = decideStewardSignOff("produce report", { verdict: "accept", summary: "The cited report contains every required row." }, "run-2");
		expect(out.isError).toBe(false);
		expect(out.resultText).toContain("Sign-off ACCEPTED");
		expect(out.logEntry).toContain("steward accept; run run-2");
	});

	it("reports the steward's missing evidence", () => {
		const out = decideStewardSignOff(
			"produce report",
			{ verdict: "reject", summary: "The count is not cited.", missingEvidence: ["Saved output with the recursive file count", "A matching table row count"] },
			"run-3",
		);
		expect(out.isError).toBe(true);
		expect(out.resultText).toContain("Saved output with the recursive file count; A matching table row count");
		expect(out.logEntry).toContain("steward run run-3");
	});

	it("treats redirect as a rejected sign-off with one next action", () => {
		const out = decideStewardSignOff(
			"produce report",
			{ verdict: "redirect", summary: "The worker inspected only the top level.", nextAction: "Repeat the snapshot recursively." },
			"run-4",
		);
		expect(out.isError).toBe(true);
		expect(out.resultText).toContain("Repeat the snapshot recursively.");
	});

	it("does not turn let_run into acceptance", () => {
		const out = decideStewardSignOff("produce report", { verdict: "let_run", summary: "Continue the current work." }, "run-5");
		expect(out.isError).toBe(true);
		expect(out.resultText).toContain("let_run instead of a sign-off verdict");
	});
});
