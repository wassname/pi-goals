// PI/Claude: is a background subagent of this session still running? A snapshot of the processes below this one,
// not a wait: the run's own completion notice wakes the session. The approach is from wassname/pi-intercom-supervisor
// (after @monotykamary/pi-supervisor, MIT).
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);
/** pi-subagents 0.84 runs a background child in `node --import …/pi-subagents/runner-peer-preload.mjs …`, below the parent Pi
 * (seen with ps on Pi 1.6, 2026-11-27). A foreground child shares the parent's process and blocks its turn, so it never meets a stop. */
export const SUBAGENT_RUNNER = "pi-subagents/runner-peer";

/** How many processes below this one have `marker` in their command line. */
export async function liveDescendants(marker = SUBAGENT_RUNNER, root = process.pid): Promise<number> {
	if (process.platform !== "linux" && process.platform !== "darwin") return 0;
	const { stdout } = await run("ps", ["-eo", "pid=,ppid=,args="], { maxBuffer: 16 * 1024 * 1024 });
	const rows = stdout.split("\n").map((line) => /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line)).flatMap((match) => match ? [{ pid: Number(match[1]), ppid: Number(match[2]), args: match[3] }] : []);
	const below = new Set([root]);
	for (let grew = true; grew;) {
		grew = false;
		for (const row of rows) if (below.has(row.ppid) && !below.has(row.pid)) { below.add(row.pid); grew = true; }
	}
	return rows.filter((row) => row.pid !== root && below.has(row.pid) && row.args.includes(marker)).length;
}
