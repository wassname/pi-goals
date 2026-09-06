import { describe, expect, it } from "vitest";
import { supervisorCommand } from "../src/herdr.js";

describe("supervisor pane command", () => {
	it("forks the planning session with an explicit supervisor role and model", () => {
		const command = supervisorCommand({
			cwd: "/repo",
			sourceSessionFile: "/sessions/worker.jsonl",
			workerSessionId: "worker-12345678",
			planPath: "/repo/.pi/plan/worker-v1.md",
			approvalId: "approval-1",
			extensionPath: "/repo/src/index.ts",
			model: "provider/supervisor",
		});
		expect(command).toContain("'PI_GOALS_ROLE=supervisor'");
		expect(command).toContain("'pi' '--no-extensions' '-e' '/repo/src/index.ts'");
		expect(command).toContain("'-e' 'npm:pi-intercom' '-e' 'npm:@wassname2/pi-supervise'");
		expect(command).toContain("'--fork' '/sessions/worker.jsonl'");
		expect(command).toContain("'--model' 'provider/supervisor'");
		expect(command).not.toContain("pi-subagents");
	});
});
