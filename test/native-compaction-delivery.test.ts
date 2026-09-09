import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";

it.each(["worker", "supervisor"] as const)("real Pi preserves %s delivery through compaction success, failure and cancellation", async role => {
	for (const outcome of ["success", "failure", "cancel"]) {
		const cwd = mkdtempSync(join(tmpdir(), "goals-native-compaction-"));
		const agentDir = join(cwd, "agent");
		mkdirSync(agentDir);
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ compaction: { enabled: false, keepRecentTokens: 1000, reserveTokens: 1000 }, retry: { enabled: false } }));
		let requests = 0;
		const server = createServer(async (req, res) => {
			for await (const _chunk of req) { /* consume local request */ }
			requests++;
			if (outcome === "failure" && requests === 3) { res.writeHead(400); res.end(JSON.stringify({ error: { message: "deterministic compaction failure" } })); return; }
			res.writeHead(200, { "content-type": "text/event-stream" });
			res.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "Inspected the supplied context." }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 8000, completion_tokens: 10, total_tokens: 8010 } })}\n\ndata: [DONE]\n\n`);
		});
		await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
		const address = server.address();
		if (!address || typeof address === "string") throw new Error("No local model port");
		const child = spawn(resolve("node_modules/.bin/pi"), ["--mode", "rpc", "--no-extensions", "--model", "offline/test", "-e", resolve("test/fixtures/offline-model.ts"), "-e", resolve("test/fixtures/compaction-delivery.ts")], { cwd, env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, PI_GOALS_OFFLINE_MODEL_URL: `http://127.0.0.1:${address.port}`, PI_GOALS_TEST_DELIVERY_ROLE: role, PI_GOALS_TEST_COMPACTION: outcome } });
		const messages: any[] = [];
		let buffer = "", stderr = "";
		child.stdout.on("data", data => {
			buffer += data;
			while (buffer.includes("\n")) { const n = buffer.indexOf("\n"); const line = buffer.slice(0, n); buffer = buffer.slice(n + 1); if (line.trim()) messages.push(JSON.parse(line)); }
		});
		child.stderr.on("data", data => { stderr += data; });
		const send = (message: object) => child.stdin.write(`${JSON.stringify(message)}\n`);
		const wait = async (predicate: (message: any) => boolean) => {
			for (let i = 0; i < 500; i++) { const found = messages.find(predicate); if (found) return found; await new Promise(done => setTimeout(done, 20)); }
			throw new Error(`Timed out ${role}/${outcome}: ${stderr}\n${JSON.stringify(messages.slice(-8))}`);
		};
		try {
			send({ type: "prompt", id: "seed", message: "Inspect this bounded test context. " + "Saved observation. ".repeat(2000) });
			await wait(m => m.type === "agent_settled");
			messages.length = 0;
			send({ type: "prompt", id: "second-turn", message: "Keep this most recent turn for continued work. " + "Recent context. ".repeat(500) });
			await wait(m => m.type === "agent_settled");
			send({ type: "compact", id: "compact" });
			const completion = await wait(m => m.type === "response" && m.id === "compact");
			expect(completion.success, JSON.stringify(completion)).toBe(outcome === "success");
			await wait(m => m.type === "message_start" && m.message?.role === "user" && JSON.stringify(m.message.content).includes("Retained evidence arrived"));
			await wait(m => m.type === "message_end" && m.message?.role === "user" && JSON.stringify(m.message.content).includes("Retained evidence arrived"));
			send({ type: "get_state", id: "state" });
			const state = await wait(m => m.type === "response" && m.id === "state");
			const transcript = readFileSync(state.data.sessionFile, "utf8");
			expect(transcript).toContain('"direction":"queued"');
			expect(transcript).toContain('"direction":"in"');
			expect(messages.filter(m => m.type === "message_start" && m.message?.role === "user" && JSON.stringify(m.message.content).includes("Retained evidence arrived"))).toHaveLength(1);
			expect(messages.filter(m => m.type === "extension_error")).toEqual([]);
			console.log(`real Pi ${role}/${outcome}: retained message presented once and saved, no extension errors`);
		} finally {
			child.kill("SIGTERM"); await once(child, "exit");
			await new Promise<void>(done => server.close(() => done()));
			rmSync(cwd, { recursive: true, force: true });
		}
	}
}, 45_000);
