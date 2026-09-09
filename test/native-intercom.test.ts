import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";
import { approveGoalDescription, steerWorkerDescription, supervisorStoppedReview } from "../src/prompts.js";

// Pi/OpenAI: RPC drives test inputs only; the two sessions communicate exclusively through Intercom.
class Driver {
	messages: any[] = [];
	stderr = "";
	private waiters: Array<{ predicate: (value: any) => boolean; resolve: (value: any) => void }> = [];
	constructor(readonly process: ChildProcessWithoutNullStreams) {
		let buffer = "";
		process.stdout.setEncoding("utf8");
		process.stdout.on("data", chunk => {
			buffer += chunk;
			while (buffer.includes("\n")) {
				const newline = buffer.indexOf("\n");
				const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
				if (!line.trim()) continue;
				const message = JSON.parse(line);
				this.messages.push(message);
				for (const waiter of [...this.waiters]) if (waiter.predicate(message)) { this.waiters.splice(this.waiters.indexOf(waiter), 1); waiter.resolve(message); }
			}
		});
		process.stderr.on("data", chunk => { this.stderr += String(chunk); });
	}
	send(value: object): void { this.process.stdin.write(`${JSON.stringify(value)}\n`); }
	wait(predicate: (value: any) => boolean): Promise<any> {
		const found = this.messages.find(predicate);
		if (found) return Promise.resolve(found);
		return new Promise((resolveWait, reject) => {
			const timer = setTimeout(() => reject(new Error(`Pi response timed out. stderr=${this.stderr}\nLast messages=${JSON.stringify(this.messages.slice(-5))}`)), 8000);
			this.waiters.push({ predicate, resolve: value => { clearTimeout(timer); resolveWait(value); } });
		});
	}
}

it("runs a forked Pi supervisor and receives its exact instruction in another Pi session", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "goals-native-pair-"));
	const agentDir = join(cwd, "agent");
	const advice = "Read the real outputs before declaring completion.";
	const children: ChildProcessWithoutNullStreams[] = [];
	let worker: Driver | undefined;
	let supervisor: Driver | undefined;
	let workerFile: string | undefined;
	let supervisorFile: string | undefined;
	let supervisorTools: string[] = [];
	let supervisorRequest: any;
	const server = createServer(async (request, response) => {
		let body = "";
		for await (const chunk of request) body += chunk;
		const input = JSON.parse(body);
		const latest = input.messages.filter((message: any) => !JSON.stringify(message.content).includes("Full active plan:")).at(-1);
		const steer = latest.role === "user" && JSON.stringify(latest.content).includes("The worker stopped.");
		if (steer) {
			supervisorRequest = input;
			supervisorTools = input.tools.map((tool: any) => tool.function.name);
		}
		response.writeHead(200, { "content-type": "text/event-stream" });
		const delta = steer ? { tool_calls: [{ index: 0, id: "test-steer", type: "function", function: { name: "SteerWorker", arguments: JSON.stringify({ instruction: advice }) } }] } : { content: "Test context retained. Actual outputs still need inspection." };
		response.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
		response.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: steer ? "tool_calls" : "stop" }], usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } })}\n\n`);
		response.end("data: [DONE]\n\n");
	});
	await new Promise<void>(resolveListen => server.listen(0, "127.0.0.1", resolveListen));
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("Offline server did not bind.");
	const env = { ...process.env, PI_CODING_AGENT_DIR: agentDir, PI_GOALS_OFFLINE_MODEL_URL: `http://127.0.0.1:${address.port}` };
	const broker = spawn(process.execPath, [resolve("node_modules/tsx/dist/cli.mjs"), resolve("node_modules/pi-intercom/broker/broker.ts")], { env });
	children.push(broker);
	try {
		await new Promise<void>((resolveReady, reject) => {
			const timer = setTimeout(() => reject(new Error("Broker did not start.")), 5000);
			broker.stdout.on("data", chunk => { if (String(chunk).includes("Intercom broker started")) { clearTimeout(timer); resolveReady(); } });
			broker.once("exit", code => { clearTimeout(timer); reject(new Error(`Broker exited ${code}`)); });
		});
		const common = ["--mode", "rpc", "--no-extensions", "--model", "offline/test", "-e", resolve("test/fixtures/offline-model.ts")];
		const workerProcess = spawn(resolve("node_modules/.bin/pi"), [...common, "-e", resolve("test/fixtures/intercom-worker.ts")], { cwd, env });
		children.push(workerProcess);
		worker = new Driver(workerProcess);
		worker.send({ type: "prompt", id: "planning", message: "Retain this planning context for the supervisor fork." });
		await worker.wait(message => message.type === "agent_end");
		worker.send({ type: "get_state", id: "worker-state" });
		const state = await worker.wait(message => message.type === "response" && message.id === "worker-state");
		workerFile = state.data.sessionFile;
		expect(workerFile).toBeTruthy();
		writeFileSync(join(cwd, "plan.md"), "1. [ ] goal: inspect actual outputs\n  - discriminator: raw output inspected\n");
		mkdirSync(join(agentDir, "extensions"), { recursive: true });
		writeFileSync(join(agentDir, "extensions/profile-tools.ts"), `export { default } from ${JSON.stringify(resolve("test/fixtures/profile-tools.ts"))};`);
		// Exercise normal discovery in an isolated profile; never load the user's extensions in this test.
		const supervisorProcess = spawn(resolve("node_modules/.bin/pi"), [...common.filter(arg => arg !== "--no-extensions"), "-e", resolve("src/index.ts"), "--fork", workerFile!], { cwd, env: {
			...env, PI_GOALS_ROLE: "supervisor", PI_GOALS_WORKER_ID: state.data.sessionId, PI_GOALS_OWNER_SESSION_ID: state.data.sessionId,
			PI_GOALS_PLAN_PATH: join(cwd, "plan.md"), PI_GOALS_APPROVAL_ID: "native-pair-test", PI_GOALS_MODEL_EXPLICIT: "0",
		} });
		children.push(supervisorProcess);
		supervisor = new Driver(supervisorProcess);
		const received = await worker.wait(message => message.type === "message_start" && message.message?.role === "user" && JSON.stringify(message.message.content).includes(`[supervisor] ${advice}`));
		expect(JSON.stringify(received)).toContain(advice);
		const result = await supervisor.wait(message => message.type === "tool_execution_end" && message.toolName === "SteerWorker");
		expect(result.isError).toBe(false);
		expect(supervisorTools).toContain("SteerWorker");
		expect(supervisorTools).toContain("intercom");
		expect(supervisorTools).toContain("bash");
		expect(supervisorTools).toContain("edit");
		expect(supervisorTools).toContain("write");
		expect(supervisorTools).toContain("profile_inspection");
		expect(JSON.stringify(supervisorRequest.messages)).toContain(supervisorStoppedReview);
		const description = (name: string) => supervisorRequest.tools.find((tool: any) => tool.function.name === name).function.description;
		expect(description("SteerWorker")).toBe(steerWorkerDescription);
		expect(description("ApproveGoal")).toBe(approveGoalDescription);
		supervisor.send({ type: "get_state", id: "supervisor-state" });
		const supervisorState = await supervisor.wait(message => message.type === "response" && message.id === "supervisor-state");
		supervisorFile = supervisorState.data.sessionFile;
		expect(supervisorFile).not.toBe(workerFile);
		expect(readFileSync(supervisorFile!, "utf8")).toContain("Retain this planning context");
		console.log(`Native Pi pair: fork retained planning context; SteerWorker delivered exactly: ${advice}`);
	} finally {
		if (process.env.PI_GOALS_EVIDENCE_DIR) {
			mkdirSync(process.env.PI_GOALS_EVIDENCE_DIR, { recursive: true });
			for (const [name, driver] of [["worker", worker], ["supervisor", supervisor]] as const) if (driver) {
				writeFileSync(join(process.env.PI_GOALS_EVIDENCE_DIR, `${name}-events.jsonl`), driver.messages.map(message => JSON.stringify(message)).join("\n"));
				writeFileSync(join(process.env.PI_GOALS_EVIDENCE_DIR, `${name}-stderr.txt`), driver.stderr);
			}
		}
		for (const child of children.reverse()) if (child.exitCode === null) { child.kill("SIGTERM"); await once(child, "exit"); }
		server.closeAllConnections(); server.close();
		rmSync(cwd, { recursive: true, force: true });
	}
}, 25_000);
