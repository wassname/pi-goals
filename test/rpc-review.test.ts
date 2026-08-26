import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
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
	it("opens Refine's editor before it starts the revision turn", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "pi-goals-rpc-"));
		let requestCount = 0;
		let planPath = "";
		const server = createServer((_request, response) => {
			requestCount++;
			if (requestCount === 1) {
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

			client.send({ type: "prompt", id: "goals", message: "/goals work out the thing" });
			const review = await client.waitFor((message) => message.type === "extension_ui_request" && message.method === "select");
			client.send({ type: "extension_ui_response", id: review.id, value: "Refine" });
			const editor = await client.waitFor((message) => message.type === "extension_ui_request" && message.method === "editor");
			expect(requestCount).toBe(2);

			const revisionStart = client.messages.length;
			client.send({ type: "extension_ui_response", id: editor.id, value: "Name the produced file." });
			await client.waitFor((message) => message.type === "agent_end", revisionStart);
			expect(requestCount).toBe(3);
		} finally {
			pi.kill();
			server.close();
			rmSync(cwd, { recursive: true, force: true });
		}
	}, 15_000);
});
