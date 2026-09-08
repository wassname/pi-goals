/** Test-only Herdr adapter. Starts a real supervisor Pi in RPC mode, never a live pane. */
import { spawn } from "node:child_process";
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import goals from "../../src/index.js";

export default function testHost(pi: ExtensionAPI): void {
	const children: ReturnType<typeof spawn>[] = [];
	goals({ ...pi, exec: async (command, args, options) => {
		if (command !== "herdr") return pi.exec(command, args, options);
		if (args[0] === "pane") return { code: 0, stdout: JSON.stringify({ result: { pane: { pane_id: "test-supervisor-pane" } } }), stderr: "", killed: false };
		if (args[1] === "start") {
			const native = args.slice(args.indexOf("--") + 1);
			// The worker's test-only -e host must not become the supervisor package. The fixture
			// profile points at the untouched packed package; override only the UI mode for this test.
			const child = spawn(process.execPath, [process.argv[1], "--mode", "rpc", "--session", native[native.indexOf("--session") + 1], "--model", "offline/test"], {
				cwd: process.cwd(), env: process.env, stdio: ["pipe", "pipe", "pipe"],
			});
			children.push(child);
			const log = join(process.cwd(), "supervisor-rpc.jsonl");
			child.stdout?.on("data", chunk => appendFileSync(log, chunk));
			child.stderr?.on("data", chunk => appendFileSync(join(process.cwd(), "supervisor-stderr.log"), chunk));
		}
		return { code: 0, stdout: "{}", stderr: "", killed: false };
	} });
	pi.on("session_shutdown", () => { for (const child of children) child.kill(); });
}
