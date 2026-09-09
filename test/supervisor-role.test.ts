import { expect, it } from "vitest";
import { restoredSupervisor } from "../src/supervisor-session.js";

const binding = { workerSessionId: "worker", ownerSessionId: "worker", planPath: "/repo/plan.md", approvalId: "pairing" };
it("restores complete supervisor identity even for a stopped fork without worker state", () => {
	expect(restoredSupervisor([{ type: "custom", customType: "pi-goals-supervisor-binding", data: binding }])).toEqual(binding);
});
it("migrates an older supervisor marker without inventing a pairing", () => {
	expect(restoredSupervisor([
		{ type: "custom", customType: "pi-goals-state", data: { approvalId: "pairing", phase: null } },
		{ type: "custom", customType: "pi-goals-visible-supervisor-v2", data: { workerSessionId: "worker", planPath: "/repo/plan.md" } },
	])).toEqual(binding);
});
it("refuses incomplete supervisor identity instead of returning worker mode", () => {
	expect(() => restoredSupervisor([{ type: "custom", customType: "pi-goals-supervisor-binding", data: { workerSessionId: "worker" } }])).toThrow("incomplete");
	expect(() => restoredSupervisor([{ type: "custom", customType: "pi-goals-visible-supervisor-v2", data: {} }])).toThrow("Worker mode was not enabled");
	for (const customType of ["pi-goals-supervisor-binding", "pi-goals-visible-supervisor-v2"]) expect(() => restoredSupervisor([{ type: "custom", customType, data: null }])).toThrow(/worker mode was not enabled/i);
	expect(restoredSupervisor([{ type: "custom", customType: "pi-goals-state", data: { phase: "working" } }])).toBeUndefined();
});
