import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const stream = (res: import("node:http").ServerResponse, delta: object, finish = "stop") => {
	res.writeHead(200, { "content-type": "text/event-stream" });
	for (const data of [{ choices: [{ index: 0, delta, finish_reason: null }] }, { choices: [{ index: 0, delta: {}, finish_reason: finish }] }]) res.write(`data: ${JSON.stringify(data)}\n\n`);
	res.end("data: [DONE]\n\n");
};

describe("two real Pi sessions with the actual Intercom broker (Herdr mocked)", () => {
	it("forks, pairs, reviews a goal and invokes a fresh offline evidence judge", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "goals-supervisor-rpc-"));
		// Pack real production dependencies, then run outside every checkout with no install/symlink.
		const packed = JSON.parse(execFileSync("npm", ["pack", "--json", "--ignore-scripts", "--cache", "/tmp/pi-goals-npm-cache", "--pack-destination", cwd], { cwd: resolve("."), encoding: "utf8" }))[0];
		execFileSync("tar", ["-xzf", join(cwd, packed.filename), "-C", cwd]);
		const packageRoot = join(cwd, "package");
		const manifest = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
		expect(manifest.bundledDependencies).toEqual(["pi-intercom", "@sting8k/pi-vcc"]);
		expect(existsSync(join(packageRoot, "node_modules/pi-intercom/broker/broker.ts"))).toBe(true);
		expect(existsSync(join(packageRoot, "src/internal/supervisor/index.ts"))).toBe(true);
		expect(existsSync(join(packageRoot, "node_modules/@sting8k/pi-vcc/src/core/summarize.ts"))).toBe(true);
		expect(packed.files.some((file: { path: string }) => /node_modules\/(?:@earendil-works|typebox)\//.test(file.path))).toBe(false);
		expect(existsSync(join(packageRoot, "THIRD_PARTY_NOTICES.md"))).toBe(true);
		const host = join(cwd, "herdr-test-host.ts");
		writeFileSync(host, readFileSync(resolve("test/fixtures/herdr-test-host.ts"), "utf8").replace('"../../src/index.js"', JSON.stringify(join(packageRoot, "src/index.ts"))));
		// Only the worker's Herdr exec is wrapped. Supervisor loads the untouched package manifest.
		const resources = manifest.pi.extensions.flatMap((path: string) => ["-e", path === "./src/index.ts" ? host : join(packageRoot, path)]);
		let planPath = ""; let reviewCalls = 0; let judgeCalls = 0;
		const supervisorModels: string[] = []; const judgeModels: string[] = []; const workerModels: string[] = [];
		const server = createServer((req, res) => {
			let raw = ""; req.on("data", chunk => { raw += chunk; }); req.on("end", () => {
				const body = JSON.parse(raw); const messages = body.messages; const last = messages.at(-1); const text = typeof last.content === "string" ? last.content : JSON.stringify(last.content);
				const names = (body.tools ?? []).map((tool: any) => tool.function.name);
				const call = (name: string, args: object) => stream(res, { tool_calls: [{ index: 0, id: `call-${Date.now()}`, type: "function", function: { name, arguments: JSON.stringify(args) } }] }, "tool_calls");
				if (last.role === "tool" && messages.at(-2)?.tool_calls?.some((c: any) => c.function.name === "write")) return call("RequestPlanReview", {});
				if (last.role === "tool") return stream(res, { content: "Check complete." });
				if (names.includes("review_goal")) {
					supervisorModels.push(body.model);
					const request = text.includes("Goal sign-off:");
					if (request) { reviewCalls++; return call("review_goal", { decision: "approve", reason: "This goal remains faithful to the plan." }); }
					return call("let_it_run", { reason: "Ready selected; worker starting" });
				}
				if (text.includes("intercom status")) return call("intercom", { action: "status" });
				if (names.includes("CompleteGoal")) {
					if (text.includes("sign off first")) return call("CompleteGoal", { goal: "first" });
					if (text.includes("We're in plan mode.") || text.includes("[PLANNING MODE]")) return call("write", { path: planPath, content: "# Plan\n\n## User-visible result\n\nTwo text files.\n\n## Goals\n\n1. [ ] goal: first\n  - evidence: evidence.txt says PASS\n2. [ ] goal: second\n\n## Log\n" });
					workerModels.push(body.model); return stream(res, { content: "Worker is ready." });
				}
				judgeCalls++; judgeModels.push(body.model); stream(res, { content: "## checks:\n- evidence.txt: `PASS`; the saved receipt passed\n\nVERDICT: accept\nmissing:" });
			});
		});
		await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
		const address = server.address(); if (!address || typeof address === "string") throw new Error("Offline HTTP server did not start");
		const agentDir = join(cwd, ".agent"); mkdirSync(agentDir);
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ packages: [packageRoot] }));
		writeFileSync(join(agentDir, "models.json"), JSON.stringify({ providers: { offline: { baseUrl: `http://127.0.0.1:${address.port}`, apiKey: "test", api: "openai-completions", models: ["test", "planning", "worker", "supervisor", "judge"].map(id => ({ id, name: `Offline ${id}`, reasoning: false, input: ["text"], contextWindow: 200_000, maxTokens: 1000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } })) } } }));
		const modelDir = join(agentDir, "pi-goals"); mkdirSync(modelDir);
		for (const role of ["worker", "supervisor"]) writeFileSync(join(modelDir, `${role}-model.json`), JSON.stringify({ provider: "offline", id: role }));
		writeFileSync(join(cwd, "evidence.txt"), "PASS\n");
		const child = spawn(resolve("node_modules/.bin/pi"), ["--mode", "rpc", "--no-extensions", "--model", "offline/test", ...resources], {
			cwd, env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, PI_INTERCOM_SCOPE_ID: `test-${Date.now()}`, HERDR_ENV: "1", HERDR_PANE_ID: "test-worker-pane", PI_SUPERVISOR_DEBUG: "1" }, stdio: ["pipe", "pipe", "pipe"],
		});
		const events: any[] = []; let buffer = ""; let stderr = "";
		const waits = new Set<(event: any) => void>();
		child.stdout.on("data", chunk => { buffer += chunk; while (buffer.includes("\n")) { const at = buffer.indexOf("\n"); const line = buffer.slice(0, at); buffer = buffer.slice(at + 1); if (!line) continue; const event = JSON.parse(line); events.push(event); for (const fn of waits) fn(event); } });
		child.stderr.on("data", chunk => { stderr += chunk; });
		const send = (message: object) => child.stdin.write(`${JSON.stringify(message)}\n`);
		const wait = (predicate: (event: any) => boolean, from = 0) => new Promise<any>((done, reject) => {
			const found = events.slice(from).find(predicate); if (found) return done(found);
			const timeout = setTimeout(() => { waits.delete(listener); reject(new Error(`RPC timeout; stderr: ${stderr}\nsupervisor: ${existsSync(join(cwd, "supervisor-stderr.log")) ? readFileSync(join(cwd, "supervisor-stderr.log"), "utf8") : "not started"}\nevents: ${JSON.stringify(events.filter(e => e.method === "notify" || e.type === "extension_error")) + JSON.stringify(events.slice(-2))}`)); }, 20_000);
			const listener = (event: any) => { if (predicate(event)) { clearTimeout(timeout); waits.delete(listener); done(event); } }; waits.add(listener);
		});
		try {
			send({ type: "get_state", id: "state" }); const state = await wait(e => e.type === "response" && e.id === "state");
			planPath = join(cwd, ".pi/plan", `${state.data.sessionId}-v1.md`);
			const diagnosticAt = events.length;
			send({ type: "prompt", id: "diagnostic", message: "intercom status" });
			const diagnostic = await wait(e => e.type === "tool_execution_end" && e.toolName === "intercom", diagnosticAt);
			expect(JSON.stringify(diagnostic), "Actual Intercom must connect before testing goals").toContain("Connected: Yes");
			await wait(e => e.type === "agent_end", diagnosticAt);
			send({ type: "prompt", id: "plan", message: "/goals plan create the outputs" });
			const menu = await wait(e => e.type === "extension_ui_request" && e.method === "select");
			send({ type: "set_model", id: "planning-model", provider: "offline", modelId: "planning" });
			expect((await wait(e => e.type === "response" && e.id === "planning-model")).success).toBe(true);
			const readyAt = events.length;
			send({ type: "extension_ui_response", id: menu.id, value: "Ready" });
			await wait(e => e.type === "message_start" && JSON.stringify(e.message).includes("Work the goals"), readyAt);
			await wait(e => e.type === "agent_end", readyAt);
			send({ type: "prompt", id: "judge-model", message: "/goals judge offline/judge" });
			await wait(e => e.type === "response" && e.id === "judge-model");
			const signoffAt = events.length;
			send({ type: "prompt", id: "signoff", message: "sign off first" });
			await wait(e => e.type === "tool_execution_end" && e.toolName === "CompleteGoal", signoffAt);
			expect(readFileSync(planPath, "utf8")).toContain("[x] goal: first"); expect(reviewCalls).toBe(1); expect(judgeCalls).toBe(1);
			expect(readFileSync(planPath, "utf8")).toContain("[ ] goal: second");
			expect(workerModels).toEqual(["worker"]);
			expect(supervisorModels.length).toBeGreaterThan(0); expect(supervisorModels.every(model => model === "supervisor")).toBe(true);
			expect(judgeModels).toEqual(["judge"]);
			for (const role of ["planning", "worker", "supervisor"]) expect(JSON.parse(readFileSync(join(modelDir, `${role}-model.json`), "utf8"))).toEqual({ provider: "offline", id: role });
		} finally { send({ type: "abort" }); child.kill(); server.close(); await new Promise(done => child.once("close", done)); rmSync(cwd, { recursive: true, force: true }); }
	}, 55_000);
});
