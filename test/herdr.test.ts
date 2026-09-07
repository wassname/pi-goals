import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { closeSupervisorPane, openSupervisorPane, supervisorCommand } from "../src/herdr.js";

function input() {
	return {
		cwd: "/repo",
		sourceSessionFile: "/sessions/worker.jsonl",
		workerSessionId: "worker-12345678",
		workerIntercomId: "intercom-12345678",
		planPath: "/repo/.pi/plan/worker-v1.md",
		approvalId: "approval-1",
		extensionPath: "/repo/src/index.ts",
		model: "provider/supervisor",
	};
}

afterEach(() => vi.unstubAllEnvs());

describe("supervisor pane command", () => {
	it("forks the planning session with an explicit supervisor role and model", () => {
		const command = supervisorCommand(input());
		expect(command).toContain("'PI_GOALS_ROLE=supervisor'");
		expect(command).toContain("'PI_GOALS_WORKER_INTERCOM_ID=intercom-12345678'");
		expect(command).toContain("'pi' '--no-extensions' '-e' 'npm:pi-intercom' '-e' 'npm:@wassname2/pi-supervise@0.0.4' '-e' '/repo/src/index.ts'");
		expect(command).toContain("'--fork' '/sessions/worker.jsonl'");
		expect(command).toContain("'--model' 'provider/supervisor'");
		expect(command).not.toContain("Initialize supervision startup.");
		expect(command).not.toContain("pi-subagents");
	});

	it("uses a local pi-supervise extension only when explicitly requested", () => {
		vi.stubEnv("PI_GOALS_SUPERVISE_EXTENSION", "/repo/vendor/pi-supervise/src/index.ts");
		expect(supervisorCommand(input())).toContain("'-e' '/repo/vendor/pi-supervise/src/index.ts'");
	});

	it("accepts Herdr's text version output and stale pane cleanup", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "pi-goals-herdr-"));
		const bin = join(cwd, "herdr");
		writeFileSync(bin, `#!/bin/sh
if [ "$1" = "--version" ]; then echo "herdr 0.8.2"; exit 0; fi
if [ "$1" = "pane" ] && [ "$2" = "split" ]; then echo '{"pane_id":"new-pane"}'; exit 0; fi
if [ "$1" = "pane" ] && [ "$2" = "run" ]; then if [ "$HERDR_SMOKE_RUN_FAIL" = "1" ]; then echo "run failed" >&2; exit 1; fi; echo '{}'; exit 0; fi
if [ "$1" = "pane" ] && [ "$2" = "close" ]; then echo '{"error":{"code":"PANE_GONE"}}' >&2; exit 1; fi
exit 2
`);
		chmodSync(bin, 0o755);
		vi.stubEnv("HERDR_ENV", "1");
		vi.stubEnv("HERDR_BIN_PATH", bin);
		try {
			await expect(openSupervisorPane(input())).resolves.toBe("new-pane");
			await expect(closeSupervisorPane("new-pane")).resolves.toBeUndefined();
			vi.stubEnv("HERDR_SMOKE_RUN_FAIL", "1");
			await expect(openSupervisorPane(input())).rejects.toThrow("run failed");
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});
});
