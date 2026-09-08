import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";

describe("packed Intercom registration in real Pi (no model call)", () => {
	it.each(["bundled", "installed before goals", "installed after goals"])("registers one transport and one tool: %s", async (order) => {
		const cwd = mkdtempSync(join(tmpdir(), "goals-registration-"));
		const packed = JSON.parse(execFileSync("npm", ["pack", "--json", "--ignore-scripts", "--cache", "/tmp/pi-goals-npm-cache", "--pack-destination", cwd], { cwd: resolve("."), encoding: "utf8" }))[0];
		execFileSync("tar", ["-xzf", join(cwd, packed.filename), "-C", cwd]);
		const root = join(cwd, "package");
		const external = join(root, "node_modules/pi-intercom");
		const agentDir = join(cwd, "profile"); mkdirSync(agentDir);
		const packages = order === "bundled" ? [root] : order === "installed before goals" ? [external, root] : [root, external];
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ packages }));
		const probe = join(cwd, "probe.ts");
		writeFileSync(probe, `import { writeFileSync } from "node:fs";
export default function(pi) {
 pi.registerCommand("registrationreload", { handler: async (_args, ctx) => { await ctx.reload(); } });
 pi.on("resources_discover", () => {
  let registrations = 0;
  pi.events.emit("intercom:extension-register", { namespace: "goals-registration-check", ownerEligible: false, onEvent() {}, onReady() { registrations++; } });
  writeFileSync(${JSON.stringify(join(cwd, "registration.json"))}, JSON.stringify({ registrations, tools: pi.getAllTools().map(t => t.name) }));
 });
}`);
		const child = spawn(resolve("node_modules/.bin/pi"), ["--mode", "rpc", "--no-session", "-e", probe], { cwd, env: { ...process.env, PI_CODING_AGENT_DIR: agentDir }, stdio: ["pipe", "pipe", "pipe"] });
		let stderr = ""; child.stderr.on("data", chunk => { stderr += chunk; }); child.stdout.resume();
		try {
			await vi.waitFor(() => expect(existsSync(join(cwd, "registration.json")), stderr).toBe(true), { timeout: 12_000, interval: 25 });
			const report = JSON.parse(readFileSync(join(cwd, "registration.json"), "utf8"));
			expect(report.registrations).toBe(1);
			expect(report.tools.filter((name: string) => name === "intercom")).toHaveLength(1);
			expect(new Set(report.tools).size).toBe(report.tools.length);
			expect(stderr).not.toMatch(/conflicting tools|Multiple Intercom runtimes/);
			rmSync(join(cwd, "registration.json"));
			child.stdin.write(`${JSON.stringify({ type: "prompt", message: "/registrationreload" })}\n`);
			await vi.waitFor(() => expect(existsSync(join(cwd, "registration.json")), stderr).toBe(true), { timeout: 12_000, interval: 25 });
			const reloaded = JSON.parse(readFileSync(join(cwd, "registration.json"), "utf8"));
			expect(reloaded).toEqual(report);
		} finally { child.kill(); await new Promise(done => child.once("close", done)); rmSync(cwd, { recursive: true, force: true }); }
	}, 20_000);
});
