import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { describe, expect, it } from "vitest";

type RpcMessage = { type: string; id?: string; method?: string; [key: string]: unknown };

class RpcClient {
	readonly messages: RpcMessage[] = [];
	private readonly waiters: Array<{ predicate: (message: RpcMessage) => boolean; resolve: (message: RpcMessage) => void }> = [];

	constructor(readonly process: ChildProcessWithoutNullStreams) {
		const decoder = new StringDecoder("utf8");
		let buffer = "";
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
		return new Promise((resolvePromise) => this.waiters.push({ predicate, resolve: resolvePromise }));
	}
}

function streamResponse(response: import("node:http").ServerResponse, delta: object, finishReason: "stop" | "tool_calls"): void {
	response.writeHead(200, { "content-type": "text/event-stream" });
	response.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
	response.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: finishReason }] })}\n\n`);
	response.end("data: [DONE]\n\n");
}

describe("RPC review flow", () => {
	it.each([false, true])("alignment and Discuss before one Ready handoff; real-Pi same-current recovery=%s", async (recoverCurrent) => {
		const cwd = mkdtempSync(join(tmpdir(), "pi-goals-rpc-"));
		const modelDir = join(cwd, ".agent", "pi-goals"); mkdirSync(modelDir, { recursive: true });
		if (recoverCurrent) writeFileSync(join(modelDir, "worker-model.json"), JSON.stringify({ provider: "missing", id: "unavailable-worker" }));
		let requestCount = 0;
		let planPath = "";
		const server = createServer((_request, response) => {
			requestCount++;
			if (requestCount === 1 || requestCount === 4) {
				streamResponse(response, { content: "1. Should the output be a text file? 2. Keep the existing CLI only? 3. Does a saved PASS receipt prove success?" }, "stop");
				return;
			}
			if (requestCount === 3 || requestCount === 6) {
				streamResponse(response, { tool_calls: [{ index: 0, id: `review-${requestCount}`, type: "function", function: { name: "RequestPlanReview", arguments: "{}" } }] }, "tool_calls");
				return;
			}
			if (requestCount === 2) {
				streamResponse(response, {
					tool_calls: [{
						index: 0,
						id: "write-plan",
						type: "function",
						function: {
							name: "write",
							arguments: JSON.stringify({
								path: planPath,
								content: "# Plan\n\n## Goals\n\n1. [ ] goal: name the output\n  - subtle failure mode: the output has no name\n  - discriminator: the plan names the output\n\n## Log\n\n## Interview\n",
							}),
						},
					}],
				}, "tool_calls");
				return;
			}
			streamResponse(response, { content: "Plan drafted." }, "stop");
		});
		await new Promise<void>((resolvePromise) => server.listen(0, "127.0.0.1", resolvePromise));
		const address = server.address();
		if (!address || typeof address === "string") throw new Error("Offline model did not bind a TCP port.");

		const pi = spawn(resolve("node_modules/.bin/pi"), [
			"--mode", "rpc", "--no-session", "--model", "offline/test",
			"-e", resolve("test/fixtures/offline-model.ts"),
			"-e", resolve("src/index.ts"),
		], {
			cwd,
			env: {
				...process.env,
				PI_CODING_AGENT_DIR: join(cwd, ".agent"),
				PI_GOALS_OFFLINE_MODEL_URL: `http://127.0.0.1:${address.port}`,
			},
		});
		const client = new RpcClient(pi);
		try {
			client.send({ type: "get_state", id: "state" });
			const state = await client.waitFor((message) => message.type === "response" && message.id === "state");
			const sessionId = (state.data as { sessionId: string }).sessionId;
			planPath = join(cwd, ".pi", "plan", `${sessionId}-v1.md`);

			client.send({ type: "prompt", id: "off", message: "/goals steward off" });
			await client.waitFor(message => message.type === "response" && message.id === "off");
			client.send({ type: "prompt", id: "goals", message: "/goals name the output file" });
			await client.waitFor(message => message.type === "agent_end");
			expect(requestCount).toBe(1);
			expect(client.messages.some(message => message.method === "select")).toBe(false);
			client.send({ type: "prompt", id: "answers", message: "Text file, existing CLI only, and a saved PASS receipt." });
			const review = await client.waitFor(message => message.type === "extension_ui_request" && message.method === "select");
			expect(review.options).toEqual(["Ready", "Discuss", "Edit", "Cancel"]);
			const discussionAt = client.messages.length;
			client.send({ type: "extension_ui_response", id: review.id, value: "Discuss" });
			await client.waitFor(message => message.type === "agent_end", discussionAt);
			expect(requestCount).toBe(4);
			expect(client.messages.slice(discussionAt).some(message => message.method === "editor" || message.method === "select")).toBe(false);
			const answerAt = client.messages.length;
			client.send({ type: "prompt", id: "discuss-answer", message: "Use output.txt, no UI changes." });
			await client.waitFor(message => message.type === "agent_end", answerAt);
			expect(client.messages.slice(answerAt).some(message => message.method === "select")).toBe(false);
			client.send({ type: "prompt", id: "finish-discussion", message: "Yes, that is enough; the draft is still right." });
			const reviewedAgain = await client.waitFor(message => message.type === "extension_ui_request" && message.method === "select", discussionAt);
			const readyAt = client.messages.length;
			client.send({ type: "extension_ui_response", id: reviewedAgain.id, value: "Ready" });
			if (recoverCurrent) {
				await client.waitFor(message => message.type === "extension_ui_request" && message.method === "notify" && JSON.stringify(message).includes("worker model paused"), readyAt);
				client.send({ type: "set_model", id: "same-current", provider: "offline", modelId: "test" });
				expect((await client.waitFor(message => message.type === "response" && message.id === "same-current")).success).toBe(true);
				expect(JSON.parse(readFileSync(join(modelDir, "worker-model.json"), "utf8"))).toEqual({ provider: "missing", id: "unavailable-worker" });
				expect(client.messages.slice(readyAt).some(message => message.method === "select")).toBe(false);
				client.send({ type: "prompt", id: "use-current", message: "/goals model current" });
				const recoveryMenu = await client.waitFor(message => message.type === "extension_ui_request" && message.method === "select", readyAt);
				expect(JSON.parse(readFileSync(join(modelDir, "worker-model.json"), "utf8"))).toEqual({ provider: "offline", id: "test" });
				expect(JSON.parse(readFileSync(join(modelDir, "planning-model.json"), "utf8"))).toEqual({ provider: "offline", id: "test" });
				client.send({ type: "extension_ui_response", id: recoveryMenu.id, value: "Ready" });
			}
			await client.waitFor(message => message.type === "agent_end", readyAt);
			expect(client.messages.filter(message => message.type === "message_start" && JSON.stringify(message).includes("Work the goals"))).toHaveLength(1);
			expect(requestCount).toBe(7);
		} finally {
			pi.kill();
			server.close();
			rmSync(cwd, { recursive: true, force: true });
		}
	}, 15_000);
});
