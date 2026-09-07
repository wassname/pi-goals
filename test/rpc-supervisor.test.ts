import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const source = process.env.PI_GOALS_SUPERVISOR_SOURCE;
const intercom = source ? resolve(dirname(source), "../node_modules/pi-intercom/index.ts") : "";
const stream = (res: import("node:http").ServerResponse, delta: object, finish = "stop") => {
	res.writeHead(200, { "content-type": "text/event-stream" });
	for (const data of [{ choices: [{ index: 0, delta, finish_reason: null }] }, { choices: [{ index: 0, delta: {}, finish_reason: finish }] }]) res.write(`data: ${JSON.stringify(data)}\n\n`);
	res.end("data: [DONE]\n\n");
};

describe.skipIf(!source || !existsSync(intercom))("two real Pi sessions with the actual Intercom broker (Herdr mocked)", () => {
	it("forks, pairs, reviews a goal and invokes a fresh offline evidence judge", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "goals-supervisor-rpc-"));
		let planPath = ""; let reviewCalls = 0; let judgeCalls = 0;
		const server = createServer((req, res) => {
			let raw = ""; req.on("data", chunk => { raw += chunk; }); req.on("end", () => {
				const body = JSON.parse(raw); const messages = body.messages; const last = messages.at(-1); const text = typeof last.content === "string" ? last.content : JSON.stringify(last.content);
				const names = (body.tools ?? []).map((tool: any) => tool.function.name);
				const call = (name: string, args: object) => stream(res, { tool_calls: [{ index: 0, id: `call-${Date.now()}`, type: "function", function: { name, arguments: JSON.stringify(args) } }] }, "tool_calls");
				if (last.role === "tool") return stream(res, { content: "Check complete." });
				if (names.includes("review_goal")) {
					const request = text.match(/Goal sign-off request ([^ .]+)\./);
					if (request) { reviewCalls++; return call("review_goal", { requestId: request[1], decision: "approve", reason: "This goal remains faithful to the plan." }); }
					return call("let_it_run", { reason: "Ready selected; worker starting" });
				}
				if (text.includes("intercom status")) return call("intercom", { action: "status" });
				if (names.includes("CompleteGoal")) {
					if (text.includes("sign off first")) return call("CompleteGoal", { goal: "first" });
					if (text.includes("We're in plan mode.") || text.includes("[PLANNING MODE]")) return call("write", { path: planPath, content: "# Plan\n\n## User-visible result\n\nTwo text files.\n\n## Goals\n\n1. [ ] goal: first\n  - evidence: evidence.txt says PASS\n2. [ ] goal: second\n\n## Log\n" });
					return stream(res, { content: "Worker is ready." });
				}
				judgeCalls++; stream(res, { content: "## checks:\n- evidence.txt: `PASS`; the saved receipt passed\n\nVERDICT: accept\nmissing:" });
			});
		});
		await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
		const address = server.address(); if (!address || typeof address === "string") throw new Error("Offline HTTP server did not start");
		const agentDir = join(cwd, ".agent"); mkdirSync(agentDir);
		writeFileSync(join(agentDir, "models.json"), JSON.stringify({ providers: { offline: { baseUrl: `http://127.0.0.1:${address.port}`, apiKey: "test", api: "openai-completions", models: [{ id: "test", name: "Offline", reasoning: false, input: ["text"], contextWindow: 200_000, maxTokens: 1000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] } } }));
		writeFileSync(join(cwd, "evidence.txt"), "PASS\n");
		const child = spawn(resolve("node_modules/.bin/pi"), ["--mode", "rpc", "--no-extensions", "--model", "offline/test", "-e", source!, "-e", intercom, "-e", resolve("test/fixtures/herdr-test-host.ts")], {
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
			const menu = await wait(e => e.type === "extension_ui_request" && e.method === "select"); const readyAt = events.length;
			send({ type: "extension_ui_response", id: menu.id, value: "Ready" });
			await wait(e => e.type === "message_start" && JSON.stringify(e.message).includes("Work the goals"), readyAt);
			await wait(e => e.type === "agent_end", readyAt);
			const signoffAt = events.length;
			send({ type: "prompt", id: "signoff", message: "sign off first" });
			await wait(e => e.type === "tool_execution_end" && e.toolName === "CompleteGoal", signoffAt);
			expect(readFileSync(planPath, "utf8")).toContain("[x] goal: first"); expect(reviewCalls).toBe(1); expect(judgeCalls).toBe(1);
			expect(readFileSync(planPath, "utf8")).toContain("[ ] goal: second");
		} finally { send({ type: "abort" }); child.kill(); server.close(); await new Promise(done => child.once("close", done)); rmSync(cwd, { recursive: true, force: true }); }
	}, 55_000);
});
