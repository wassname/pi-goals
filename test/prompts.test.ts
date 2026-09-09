import { describe, expect, it } from "vitest";
import { approveGoalDescription, completeGoalDescription, goalApprovalRecorded, planDrafting, planningState, resync, steerWorkerDescription, supervisorPeriodicReview, supervisorPlanChangeReview, supervisorReadyReview, supervisorStartedReview, supervisorStoppedReview } from "../src/prompts.js";

describe("supervisor event tasks", () => {
	it("asks a ready or stopped worker to resume through SteerWorker rather than only review", () => {
		expect(supervisorReadyReview).toContain("Use SteerWorker");
		expect(supervisorStoppedReview).toContain("judge whether the agreed goal is actually achieved");
		expect(supervisorStoppedReview).toContain("use SteerWorker to send the next useful instruction and resume work");
		expect(supervisorStoppedReview).toContain("verified dependency");
		expect(supervisorStoppedReview).toContain("only after the results satisfy the goal");
		expect(steerWorkerDescription).toContain("A recap alone does not send an instruction");
	});

	it("asks if active work is on track and keeps productive work uninterrupted", () => {
		expect(supervisorPeriodicReview).toContain("Is the worker on track");
		expect(supervisorPeriodicReview).toContain("let productive work continue without interruption");
		expect(supervisorStartedReview).toContain("only if a correction is needed");
		expect(supervisorPlanChangeReview).toContain("claims, not proof of completion");
		expect(supervisorPlanChangeReview).toContain("Preserve authorized changes");
	});

	it("defines approval as acceptance after outcome judgment, with mechanics separate", () => {
		expect(approveGoalDescription).toMatch(/^Use only after judging that the actual result satisfies/);
		expect(approveGoalDescription).toContain("mechanical checks cannot establish success");
		expect(approveGoalDescription).toContain("If the goal is unmet or evidence is insufficient, do not approve");
		expect(approveGoalDescription).toContain("\n\nRequirements:");
		expect(goalApprovalRecorded("repair")).toContain("Use SteerWorker to tell the worker to call CompleteGoal with this exact goal text");
		expect(completeGoalDescription).toContain("Worker-only sign-off");
		expect(completeGoalDescription).not.toContain("direct the worker to run it");
	});
});

describe("planning prompt", () => {
	it("requires fact finding or a focused question before a goal", () => {
		expect(planDrafting).toContain("Use read-only repository tools or web search when either can\nresolve a fact.");
		expect(planDrafting).toContain("Do not use a question quota");
		expect(planDrafting).toContain("Briefly reframe the request in your own words to check comprehension");
		expect(planDrafting).toContain("point as unknown; do not silently replace it with an inference or turn it into a new blocking decision");
		expect(planDrafting).toContain("answer materially reduces uncertainty\nwhile discovering the right plan");
		expect(planDrafting).toContain("self-contained: state the relevant\ncontext, use the human's language and ASD-STE100");
		expect(planDrafting).toContain("placeholder goal such as \"work out the thing\"");
		expect(planDrafting).toContain("Only withhold Ready for an unanswered choice that changes scope, spending, or the user-visible result");
	});

	it("restores the same rule after compaction", () => {
		expect(planningState(".pi/plan/test.md")).toContain("web search\nwhen either can resolve a fact.");
		expect(planningState(".pi/plan/test.md")).toContain("choice that needs their approval");
		expect(planningState(".pi/plan/test.md")).toContain("Record unanswered questions as\nunknown and still present Ready");
		expect(planningState(".pi/plan/test.md")).toContain("self-contained round with relevant context and a recommendation");
	});

	it("anchors work and sign-off to the user-visible result", () => {
		expect(planDrafting).toContain("## User-visible result");
		expect(planDrafting).toContain("Take it from the original request, not from your implementation plan");
		expect(planDrafting).toContain("Future work may not defer any artifact or action named there");
		expect(resync("plan", ".pi/plan/test.md", "Compacted.")).toContain("amend the plan rather than preserving an obsolete decision");
		expect(resync("plan", ".pi/plan/test.md", "Compacted.")).toContain("implementation worker");
		expect(completeGoalDescription).toContain("visible supervisor");
		expect(completeGoalDescription).toContain("stopped worker view with no active work");
	});
});
