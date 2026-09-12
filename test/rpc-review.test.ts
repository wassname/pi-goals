import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { describe, expect, it } from "vitest";
import { foldPlan } from "../src/plan.js";

type RpcMessage = { type: string; id?: string; method?: string; [key: string]: unknown };
type ModelRequest = { messages: Array<{ role: string; content: unknown }> };

class RpcClient {
	readonly messages: RpcMessage[] = [];
	stderr = "";
	private readonly waiters: Array<{ predicate: (message: RpcMessage) => boolean; resolve: (message: RpcMessage) => void }> = [];

	constructor(readonly process: ChildProcessWithoutNullStreams) {
		const decoder = new StringDecoder("utf8");
		let buffer = "";
		process.stderr.on("data", (chunk) => { this.stderr += chunk; });
		process.stdout.on("data", (chunk) => {
			buffer += decoder.write(chunk);
			while (buffer.includes("\n")) {
				const newline = buffer.indexOf("\n");
				const line = buffer.slice(0, newline).replace(/\r$/, "");
				buffer = buffer.slice(newline + 1);
				if (!line) continue;
				const message = JSON.parse(line) as RpcMessage;
				this.messages.push(message);
				const index = this.waiters.findIndex(({ predicate }) => predicate(message));
				if (index !== -1) this.waiters.splice(index, 1)[0].resolve(message);
			}
		});
	}

	send(message: RpcMessage): void {
		this.process.stdin.write(`${JSON.stringify(message)}\n`);
	}

	waitFor(predicate: (message: RpcMessage) => boolean, after = 0): Promise<RpcMessage> {
		const existing = this.messages.slice(after).find(predicate);
		if (existing) return Promise.resolve(existing);
		return new Promise((resolvePromise, reject) => {
			const timer = setTimeout(() => {
				this.waiters.splice(this.waiters.indexOf(waiter), 1);
				reject(new Error(`RPC wait timed out: ${this.stderr}\n${JSON.stringify(this.messages.slice(-12))}`));
			}, 8_000);
			const waiter = { predicate, resolve: (message: RpcMessage) => { clearTimeout(timer); resolvePromise(message); } };
			this.waiters.push(waiter);
		});
	}
}

function streamResponse(response: import("node:http").ServerResponse, delta: object, finishReason: "stop" | "tool_calls"): void {
	response.writeHead(200, { "content-type": "text/event-stream" });
	response.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
	response.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: finishReason }] })}\n\n`);
	response.end("data: [DONE]\n\n");
}

const isSelect = (message: RpcMessage) => message.type === "extension_ui_request" && message.method === "select";
const isEditor = (message: RpcMessage) => message.type === "extension_ui_request" && message.method === "editor";
const systemText = (request: ModelRequest) => request.messages.filter(message => ["system", "developer"].includes(message.role)).map(message => message.content).join("\n");

describe("RPC review flow", () => {
	it.each(["Edit", "Discuss"])("automatically proposes a draft, handles %s, then enters the supervisor role on Ready", async (choice) => {
		const cwd = mkdtempSync(join(tmpdir(), "pi-goals-rpc-"));
		const requests: ModelRequest[] = [];
		const plan = "# Plan\n\n## Goals\n\n1. [ ] goal: name the output\n  - subtle failure mode: the output has no name\n  - discriminator: the plan names the output\n\n## Log\n";
		let planPath = "";
		const server = createServer(async (request, response) => {
			let body = "";
			for await (const chunk of request) body += chunk;
			requests.push(JSON.parse(body));
			if (requests.length === 1) {
				streamResponse(response, {
					tool_calls: [{
						index: 0, id: "write-plan", type: "function",
						function: { name: "write", arguments: JSON.stringify({ path: planPath, content: plan }) },
					}],
				}, "tool_calls");
				return;
			}
			streamResponse(response, { content: "Plan inspected." }, "stop");
		});
		await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
		const address = server.address();
		if (!address || typeof address === "string") throw new Error("Offline model did not bind a TCP port.");

		const pi = spawn(resolve("node_modules/.bin/pi"), [
			"--mode", "rpc", "--no-session", "--no-extensions", "--model", "offline/test",
			"-e", resolve("test/fixtures/offline-model.ts"),
			"-e", resolve("test/fixtures/subagent-schema.ts"),
			"-e", resolve("src/index.ts"),
		], {
			cwd,
			env: {
				// Pi/gpt-6-astra: test the parent role even when vitest itself runs in a worker.
				...Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("PI_SUBAGENT_") && !name.startsWith("PI_GOALS_"))),
				PI_CODING_AGENT_DIR: join(cwd, ".agent"),
				PI_GOALS_OFFLINE_MODEL_URL: `http://127.0.0.1:${address.port}`,
			},
		});
		const client = new RpcClient(pi);
		const exited = once(pi, "exit");
		try {
			client.send({ type: "get_state", id: "state" });
			const state = await client.waitFor((message) => message.type === "response" && message.id === "state");
			const sessionId = (state.data as { sessionId: string }).sessionId;
			planPath = join(cwd, ".pi", "plan", `${sessionId}-main.md`);

			client.send({ type: "prompt", id: "goals", message: "/goals new work out the thing" });
			const review = await client.waitFor(isSelect);
			expect(review.options).toEqual(["Ready", "Discuss", "Edit", "Cancel"]);
			expect(review.title).toContain(planPath);
			const proposal = client.messages.find(message => message.type === "message_end" && (message.message as { customType?: string })?.customType === "goal-plan-proposal");
			expect(proposal?.message).toMatchObject({ content: plan, display: true });
			expect(readFileSync(planPath, "utf8")).toBe(plan);
			expect(requests).toHaveLength(2);
			expect(systemText(requests[0])).toContain("Plan only in");

			const choiceStart = client.messages.length;
			client.send({ type: "extension_ui_response", id: review.id, value: choice });
			let approvedPlan = plan;
			if (choice === "Edit") {
				const editor = await client.waitFor(isEditor, choiceStart);
				expect(editor.prefill).toBe(plan);
				expect(requests).toHaveLength(2);
				approvedPlan = plan.replace("the plan names the output", "the plan names output.txt and its exact bytes");
				const editStart = client.messages.length;
				client.send({ type: "extension_ui_response", id: editor.id, value: approvedPlan });
				await client.waitFor(message => message.type === "extension_ui_request" && message.method === "setWidget", editStart);
				expect(readFileSync(planPath, "utf8")).toBe(approvedPlan);
				expect(requests).toHaveLength(2);
			} else {
				await client.waitFor(message => message.type === "agent_end", choiceStart);
				expect(requests).toHaveLength(3);
				expect(systemText(requests[2])).toContain("Plan only in");
				expect(JSON.stringify(requests[2].messages.at(-1))).toContain("Discuss the current draft");
				expect(client.messages.slice(choiceStart).filter(isEditor)).toEqual([]);
			}
			const beforeReady = requests.length;
			const reopenStart = client.messages.length;
			client.send({ type: "prompt", id: "review", message: "/goals review" });
			const ready = await client.waitFor(isSelect, reopenStart);
			expect(requests).toHaveLength(beforeReady);
			const readyStart = client.messages.length;
			client.send({ type: "extension_ui_response", id: ready.id, value: "Ready" });
			await client.waitFor(message => message.type === "agent_end", readyStart);
			expect(requests).toHaveLength(beforeReady + 1);
			const supervisor = requests.at(-1)!;
			expect(systemText(supervisor)).toContain("You are the goal supervisor in the main chat");
			expect(systemText(supervisor)).not.toContain("Plan only in");
			expect(JSON.stringify(supervisor.messages)).toContain(JSON.stringify(foldPlan(approvedPlan)).slice(1, -1));
			expect(client.messages.filter(message => message.type === "tool_execution_start").map(message => message.toolName)).toEqual(["write"]);
			expect(client.messages.filter(message => message.type === "extension_error")).toEqual([]);
			console.log(`RPC ${choice}: visible automatic proposal; ${choice === "Edit" ? "editor saved exact plan without model call" : "discussion retained planning role without editor"}; Ready request used supervisor role; only write executed.`);
		} finally {
			pi.kill();
			await exited;
			await new Promise<void>((done) => server.close(() => done()));
			rmSync(cwd, { recursive: true, force: true });
		}
	}, 25_000);
});
