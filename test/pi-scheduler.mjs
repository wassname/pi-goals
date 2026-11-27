// PI/OpenAI: run the published scheduler through Pi RPC, with no model calls or shared state.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const binary = process.env.PI_COMPILED_BIN ?? process.env.PI_TEST_BIN;
const root = fileURLToPath(new URL("../", import.meta.url));
const scheduler = process.env.PI_TEST_SCHEDULER ?? join(root, "node_modules/@jl1990/pi-scheduler/extensions/scheduler/index.ts");
const schedulerEnabled = process.env.PI_TEST_NO_SCHEDULER !== "1";
const extension = process.env.PI_TEST_GOALS_EXTENSION ?? join(root, "src/index.ts");

test(schedulerEnabled ? "Pi starts work and creates/removes a session reminder" : "Pi starts work and records the missing scheduler", { timeout: 90_000 }, async t => {
	assert.ok(binary, "Set PI_COMPILED_BIN to a released compiled Pi executable, or PI_TEST_BIN to a Node Pi launcher.");
	const executable = resolve(binary);
	if (process.env.PI_COMPILED_BIN) {
		const magic = readFileSync(executable).subarray(0, 4).toString("hex");
		assert.ok(["7f454c46", "4d5a9000", "cffaedfe", "feedfacf"].includes(magic), `Expected a native executable, got ${magic}`);
	}
	const dir = mkdtempSync(join(tmpdir(), "pi-goals-compiled-"));
	const version = spawnSync(executable, ["--version"], { encoding: "utf8" });
	assert.equal(version.status, 0, version.stderr);
	const records = [];
	let stderr = "";
	let buffer = "";
	let sequence = 0;
	let exited = false;
	const waiters = new Set();
	const child = spawn(executable, ["--mode", "rpc", "--offline", "--no-extensions", "--no-skills", "--no-prompt-templates", "--session-dir", join(dir, "sessions"), "-e", extension, ...(schedulerEnabled ? ["-e", scheduler] : []), "-e", join(root, "test/fixtures/intercept-startup.ts")], {
		cwd: dir,
		env: { ...process.env, PI_CODING_AGENT_DIR: join(dir, "profile"), PI_SCHEDULER_STATE_FILE: join(dir, "tasks.json") },
		stdio: ["pipe", "pipe", "pipe"],
	});
	child.stdout.setEncoding("utf8");
	child.stderr.setEncoding("utf8");
	child.stderr.on("data", chunk => { stderr += chunk; });
	child.stdout.on("data", chunk => {
		buffer += chunk;
		let end;
		while ((end = buffer.indexOf("\n")) !== -1) {
			const line = buffer.slice(0, end).replace(/\r$/, "");
			buffer = buffer.slice(end + 1);
			if (line) {
				const record = JSON.parse(line);
				records.push(record);
				if (record.type === "extension_ui_request" && record.method === "select") child.stdin.write(`${JSON.stringify({ type: "extension_ui_response", id: record.id, value: "Ready" })}\n`);
			}
		}
		for (const wake of waiters) wake();
	});
	const exit = new Promise(resolveExit => child.once("exit", (code, signal) => {
		exited = true;
		resolveExit({ code, signal });
		for (const wake of waiters) wake();
	}));
	t.after(async () => {
		child.stdin.end();
		const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
		await exit;
		clearTimeout(timer);
		const report = process.env.PI_TEST_REPORT ?? join(dir, "compiled-scheduler.json");
		const schedulerVersion = JSON.parse(readFileSync(join(dirname(scheduler), "../../package.json"), "utf8")).version;
		writeFileSync(report, JSON.stringify({ pi: version.stdout.trim(), platform: process.platform, arch: process.arch, extension, scheduler, schedulerVersion, schedulerEnabled, records, stderr }, null, 2));
		console.log(`Pi ${version.stdout.trim()} (${process.env.PI_COMPILED_BIN ? "compiled" : "Node"}); ${process.platform}/${process.arch}; report: ${report}`);
	});
	function waitFor(predicate) {
		return new Promise((resolveWait, reject) => {
			const timer = setTimeout(() => { waiters.delete(check); reject(new Error(`RPC receipt timed out. stderr: ${stderr}`)); }, 20_000);
			function check() {
				const found = records.find(predicate);
				if (!found && !exited) return;
				clearTimeout(timer); waiters.delete(check);
				if (found) resolveWait(found);
				else reject(new Error(`Pi exited before receipt. stderr: ${stderr}`));
			}
			waiters.add(check); check();
		});
	}
	async function rpc(type, data = {}) {
		const id = `request-${++sequence}`;
		child.stdin.write(`${JSON.stringify({ id, type, ...data })}\n`);
		const response = await waitFor(record => record.type === "response" && record.id === id);
		assert.equal(response.success, true, JSON.stringify(response));
		return response.data;
	}
	const commands = await rpc("get_commands");
	assert.ok(commands.commands.some(command => command.name === "goals"), "Goals extension did not load");
	if (!schedulerEnabled) {
		assert.equal(commands.commands.some(command => command.name === "schedule"), false);
		await rpc("prompt", { message: "/goals new integration" });
		await rpc("prompt", { message: "/fixture-seed" });
		await rpc("prompt", { message: "/goals review" });
		await waitFor(record => record.type === "message_end" && record.message?.customType === "fixture-input" && record.message?.content.startsWith("[pi-goals] The user approved"));
		const warning = await waitFor(record => record.type === "message_end" && record.message?.customType === "goals-startup");
		assert.equal(warning.message.display, true);
		assert.match(warning.message.content, /Scheduler warning:.*not confirmed/);
		assert.ok(records.some(record => record.type === "extension_ui_request" && record.method === "setStatus" && JSON.stringify(record).includes("scheduler: unconfirmed")));
		await rpc("prompt", { message: "/fixture-state" });
		const snapshot = await waitFor(record => record.type === "message_end" && record.message?.customType === "fixture-state");
		assert.equal(snapshot.message.details.data.phase, "working");
		assert.equal(records.some(record => record.type === "agent_start"), false);
		return;
	}
	assert.ok(commands.commands.some(command => command.name === "schedule"), `Scheduler did not load: ${stderr}`);
	await rpc("prompt", { message: "/goals new integration" });
	await rpc("prompt", { message: "/fixture-seed" });
	await rpc("prompt", { message: "/goals review" });
	const created = await waitFor(record => record.type === "message_end" && record.message?.customType === "scheduled-task" && record.message?.details?.task?.prompt?.startsWith("pi-goals-loop:"));
	const reminder = created.message.details.task;
	assert.equal(reminder.scope, "session");
	assert.equal(reminder.action, "prompt");
	assert.ok(reminder.sessionFile);
	assert.equal(readFileSync(join(dir, "tasks.json"), "utf8").includes(reminder.id), true);
	await waitFor(record => record.type === "message_end" && record.message?.customType === "fixture-input" && record.message?.content.startsWith("[pi-goals] The user approved"));
	await rpc("prompt", { message: "/fixture-state" });
	const snapshot = await waitFor(record => record.type === "message_end" && record.message?.customType === "fixture-state");
	assert.equal(snapshot.message.details.data.phase, "working");
	const approvals = records.filter(record => record.type === "message_end" && record.message?.customType === "fixture-input" && record.message?.content.startsWith("[pi-goals] The user approved"));
	assert.equal(approvals.length, 1);
	await rpc("prompt", { message: "/goals pause" });
	await waitFor(record => record.type === "extension_ui_request" && record.method === "notify" && record.message === `Removed scheduled task ${reminder.id}`);
	assert.equal(readFileSync(join(dir, "tasks.json"), "utf8").includes(reminder.id), false);
	assert.equal(records.some(record => record.type === "agent_start"), false, "A model turn was unexpectedly requested");

});
