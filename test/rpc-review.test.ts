import { type ChildProcessWithoutNullStreams, execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { expect, it } from "vitest";
import { foldPlan } from "../src/plan.js";
import { goalCheckInWake, upkeepNudges } from "../src/prompts.js";

type RpcMessage = { type: string; id?: string; method?: string; [key: string]: unknown };
type ModelRequest = { model?: string; tools?: Array<{ function: { name: string } }>; messages: Array<{ role: string; content: string | Array<{ type: string; text?: string }> }> };

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

// One real-Pi story: planning, failed work, lost delivery, correction, restored history, cleanup.
it("plans and reviews the same worker across failure, delivery retry and reload", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-goals-rpc-"));
	const requests = { parent: [] as ModelRequest[], worker: [] as ModelRequest[], helper: [] as ModelRequest[] };
	const replies = { parent: [] as any[], worker: [] as any[], helper: [] as any[] };
	const clients: RpcClient[] = [];
	let planPath = "", serial = 0, hold: (() => Promise<void>) | undefined;
	let helperId = "", helperDir = "", helperFinished = false;
	let holdRole: "parent" | "worker" | "helper" = "parent";
	const customCheckIn = `${goalCheckInWake} Preserve this custom fixture instruction.`;
	const plan = '# Plan\n\n## User voice\nKeep the greeting readable.\n\n## Goals\n- [ ] goal: deliver greeting\n  - greeting.txt must contain hello.\n\n## Log\nArchived notes stay on disk.\n';
	const call = (name: string, args: object) => ({ tool_calls: [{ index: 0, id: `fixture-${++serial}`, type: "function", function: { name, arguments: JSON.stringify(args) } }] });
	const jobs = new Map<string, import("node:http").ServerResponse>();
	const server = createServer(async (request, response) => {
		if (request.url?.startsWith("/job/")) { const name = request.url.slice(5); jobs.set(name, response); server.emit(`job-${name}`); return; }
		let body = ""; for await (const chunk of request) body += chunk;
		const input = JSON.parse(body) as ModelRequest;
		const role = input.model === "helper" ? "helper" : request.url?.startsWith("/worker") ? "worker" : "parent";
		requests[role].push(input);
		if (role === "parent" && JSON.stringify(input.messages.filter(message => message.role === "user").at(-1)?.content).includes(customCheckIn)) server.emit("owned-check-in");
		if (hold && role === holdRole) { const pending = hold; hold = undefined; await pending(); }
		if (response.destroyed) return;
		let answer = replies[role].shift();
		if (role === "helper") {
			if (JSON.stringify(input.messages.filter(message => message.role === "user").at(-1)?.content).includes("HELPER_EXPECTED_FAILURE")) { response.writeHead(400, { "content-type": "application/json" }); response.end(JSON.stringify({ error: { message: "HELPER_EXPECTED_FAILURE: deliberate provider fault" } })); return; }
			answer = input.messages.at(-1)?.role === "tool" ? { content: "HELPER_SUCCESS: inspected the approved plan without edits." } : call("read", { path: planPath });
		}
		if (role === "parent" && requests.parent.length === 1) {
			planPath = systemText(input).match(/Plan only in (.+?);/)![1];
			answer = call("write", { path: planPath, content: plan });
		}
		if (answer?.fail) { response.writeHead(400, { "content-type": "application/json" }); response.end(JSON.stringify({ error: { message: "Fixture execution failed after progress" } })); return; }
		streamResponse(response, answer || { content: "Inspected." }, answer?.tool_calls ? "tool_calls" : "stop");
	});
	await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
	const port = (server.address() as import("node:net").AddressInfo).port;
	mkdirSync(join(cwd, ".pi", "agents"), { recursive: true });
	writeFileSync(join(cwd, ".pi", "agents", "fixture-helper.md"), `---\nname: fixture-helper\ndescription: Read-only deterministic helper\ntools: read\nextensions: ${resolve("test/fixtures/offline-model.ts")}, ${resolve("src/index.ts")}\nmodel: offline/helper\ndefaultContext: fresh\nacceptanceRole: read-only\n---\nInspect only the supplied fixture path. Do not edit, delegate, approve goals or change execution modes.\n`);
	function start(role: "parent" | "worker", sessionFile?: string) {
		const child = spawn(resolve("node_modules/.bin/pi"), ["--mode", "rpc", "--no-extensions", "--model", "offline/test",
			"-e", resolve("test/fixtures/offline-model.ts"), "-e", resolve("src/index.ts"),
			"-e", resolve("node_modules/pi-intercom/index.ts"), "-e", realpathSync(resolve("node_modules/@jl1990/pi-scheduler/extensions/scheduler/index.ts")),
			...(role === "worker" ? ["-e", resolve("node_modules/pi-subagents/index.ts")] : []),
			...(sessionFile ? ["--session", sessionFile] : [])], { cwd, env: {
			...Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("PI_SUBAGENT_") && !name.startsWith("PI_GOALS_") && !name.startsWith("HERDR_"))),
			PI_CODING_AGENT_DIR: join(cwd, "agent"), PI_OFFLINE: "1", PI_INTERCOM_SCOPE_ID: basename(cwd), PI_SUBAGENTS_TEMP_ROOT: join(cwd, "subagents"),
			PI_SCHEDULER_STATE_FILE: join(cwd, "scheduler.json"), PI_GOALS_OFFLINE_MODEL_URL: `http://127.0.0.1:${port}/${role}`,
		} }); const client = new RpcClient(child); clients.push(client); return client;
	}
	async function command(client: RpcClient, message: string) {
		const after = client.messages.length, id = `command-${++serial}`;
		client.send({ type: "prompt", id, message });
		await client.waitFor(m => m.type === "response" && m.id === id, after);
	}
	async function run(client: RpcClient, role: "parent" | "worker", ...answers: any[]) {
		const after = client.messages.length; replies[role].push(...answers);
		client.send({ type: "prompt", id: `run-${++serial}`, message: "Continue the isolated fixture task." });
		await client.waitFor(m => m.type === "agent_settled", after);
	}
	async function state(client: RpcClient): Promise<any> {
		const id = `state-${++serial}`; client.send({ type: "get_state", id });
		return (await client.waitFor(m => m.type === "response" && m.id === id)).data;
	}
	const entries = (path: string) => readFileSync(path, "utf8").trim().split("\n").map(line => JSON.parse(line));
	const records = (path: string, type: string) => entries(path).filter(e => e.type === "custom" && e.customType === type).map(e => e.data);
	async function workerEvent(parent: RpcClient, after: number) {
		const event = await parent.waitFor(m => m.type === "entry_appended" && (m.entry as any)?.customType === "pi-goals-worker-event", after);
		await parent.waitFor(m => m.type === "agent_settled", parent.messages.indexOf(event));
		return (event.entry as any).data;
	}
	async function stop(client: RpcClient) { const exited = once(client.process, "exit"); client.process.kill(); await exited; }
	let parent = start("parent"), worker: RpcClient | undefined;
	try {
		parent.send({ type: "prompt", id: "new", message: "/goals new deliver the greeting" });
		await parent.waitFor(m => m.type === "agent_settled");
		expect(parent.messages.some(isSelect)).toBe(false);
		const interviewed = plan + "\n## Interview\nProvisional: output format depends on the user's answer.\n";
		await run(parent, "parent", call("write", { path: planPath, content: interviewed }), { content: "Provisional draft saved. Which greeting format do you want?" });
		expect(parent.messages.some(isSelect)).toBe(false);
		expect(records((await state(parent)).sessionFile, "pi-goals-main-supervisor-v1").at(-1).mode).toBe("planning");
		parent.send({ type: "prompt", id: "review-edit", message: "/goals review" });
		const proposal = await parent.waitFor(isSelect);
		parent.send({ type: "extension_ui_response", id: proposal.id, value: "Edit" });
		const editor = await parent.waitFor(isEditor);
		const approved = plan.replace("contain hello", "contain hello followed by a newline");
		const editAt = parent.messages.length;
		parent.send({ type: "extension_ui_response", id: editor.id, value: approved });
		await parent.waitFor(m => m.type === "extension_ui_request" && m.method === "setWidget", editAt);
		expect(readFileSync(planPath, "utf8")).toBe(approved);
		const discussion = parent.messages.length;
		parent.send({ type: "prompt", id: "discuss", message: "/goals review" });
		const discuss = await parent.waitFor(isSelect, discussion);
		parent.send({ type: "extension_ui_response", id: discuss.id, value: "Discuss" });
		await parent.waitFor(m => m.type === "response" && m.command === "prompt", discussion);
		const discussionAt = parent.messages.length;
		replies.parent.push(call("RequestPlanReview", {}), { content: "Human decision recorded." });
		parent.send({ type: "prompt", id: "discussion", message: "Keep the edited requirement. Present the settled draft for acceptance." });
		const ready = await parent.waitFor(isSelect, discussionAt);
		expect(systemText(requests.parent.at(-1)!)).toContain("Plan only in");
		const startupState = await state(parent), checkInName = `goals-${startupState.sessionId}`;
		replies.parent.push(call("list_scheduled_tasks", { includeAll: true }), call("schedule_task", { name: checkInName, action: "prompt", type: "interval", schedule: "1h", scope: "session", prompt: goalCheckInWake }));
		const readyAt = parent.messages.length;
		parent.send({ type: "extension_ui_response", id: ready.id, value: "Ready" });
		const approvedTurn = await parent.waitFor(m => m.type === "agent_end", readyAt);
		await parent.waitFor(m => m.type === "agent_settled", parent.messages.indexOf(approvedTurn));
		const normalTask = (parent.messages.slice(readyAt).find(m => m.type === "tool_execution_end" && m.toolName === "schedule_task") as any).result.details.task;
		expect(normalTask).toMatchObject({ name: checkInName, scope: "session", sessionFile: startupState.sessionFile, schedule: "1h" });
		expect(systemText(requests.parent.at(-1)!)).toContain("goal supervisor");
		expect(JSON.stringify(requests.parent.at(-1)!.messages)).toContain(JSON.stringify(foldPlan(approved)).slice(1, -1));
		await run(parent, "parent", call("manage_scheduled_task", { action: "update", id: normalTask.id, schedule: "2h", prompt: customCheckIn }));
		const initialCount = requests.parent.length;
		await command(parent, `/goals attach ${planPath}`);
		expect(requests.parent).toHaveLength(initialCount);

		// Only native pane allocation is replaced by fixture setup; everything below uses real IPC/history.
		const selfAt = parent.messages.length; await run(parent, "parent", call("intercom", { action: "status" }));
		const selfResult = parent.messages.slice(selfAt).find(m => m.type === "tool_execution_end" && m.toolName === "intercom") as any;
		const parentId = JSON.stringify(selfResult.result.content).match(/[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}/)![0];
		await command(parent, `/fixture-worker-binding ${JSON.stringify({ parentId, requestId: "rpc-assignment", task: "Deliver greeting" })}`);
		const parentState = await state(parent);
		worker = start("worker");
		await run(worker, "worker", call("intercom", { action: "list" }));
		const inspectAt = worker.messages.length, parentCount = requests.parent.length;
		await run(worker, "worker", call("AttachGoalPlan", { path: planPath, parent: parentId, requestId: "rpc-assignment" }),
			call("subagent", { action: "list", capabilities: true, agentScope: "project" }), call("subagent", { action: "status" }),
			call("OpenGoalWorker", { task: "Must remain blocked in the attached worker" }), call("ReportGoalEvent", { kind: "receipt", summary: "Attached and waiting." }));
		const inspections = worker.messages.slice(inspectAt).filter(m => m.type === "tool_execution_end" && m.toolName === "subagent");
		expect(inspections).toHaveLength(2);
		for (const inspection of inspections) { expect(inspection.isError).not.toBe(true); expect((inspection.result as any).details.results).toEqual([]); }
		expect((inspections.at(-1)!.result as any).details.spawnBudget.used).toBe(0);
		expect(worker.messages.slice(inspectAt).find(m => m.type === "tool_execution_end" && m.toolName === "OpenGoalWorker")?.isError).toBe(true);
		await expect.poll(() => requests.parent.length).toBe(parentCount + 1); // automatic turn end wakes the supervisor; the receipt itself does not
		expect(JSON.stringify(requests.parent.at(-1)!.messages)).toContain("Worker status: unclassified");
		const workerState = await state(worker), workerFile = workerState.sessionFile;
		expect(records(parentState.sessionFile, "pi-goals-worker-event").map(event => event.kind)).toEqual(["receipt", "unclassified"]); // turn end is independently observable
		const receiptNotice = entries(parentState.sessionFile).find(entry => entry.customType === "pi-goals-prompt" && String(entry.content).includes("Attached and waiting."));
		expect(Buffer.byteLength(receiptNotice.content)).toBeLessThan(1500); // routine status does not carry a history dump
		// Real native scheduler commands continue after the worker turn. Hold their HTTP
		// response so inspection observes actual running work, not a fabricated job record.
		const started = ["followed", "unfollowed"].map(name => once(server, `job-${name}`, { signal: AbortSignal.timeout(8_000) }));
		await run(worker, "worker", ...["followed", "unfollowed"].map(name => call("schedule_task", {
			name, action: "shell", type: "once", schedule: "1s", scope: "session",
			command: `${process.execPath} -e ${JSON.stringify(`fetch('http://127.0.0.1:${port}/job/${name}',{signal:AbortSignal.timeout(8000)}).then(r=>r.text()).then(console.log)`)}`,
			wakeOn: name === "followed" ? "success" : "never", followUpPrompt: "Inspect the completed fixture command.",
		})));
		await Promise.all(started);
		const unchangedHistory = readFileSync(workerFile, "utf8"), viewAt = parent.messages.length;
		if (process.env.PI_GOALS_TEST_EVIDENCE) { mkdirSync(process.env.PI_GOALS_TEST_EVIDENCE, { recursive: true }); writeFileSync(join(process.env.PI_GOALS_TEST_EVIDENCE, "worker-running.jsonl"), unchangedHistory); }
		await run(parent, "parent", call("worker_view", {}));
		const viewText = (after: number) => (parent.messages.slice(after).find(m => m.type === "tool_execution_end" && m.toolName === "worker_view") as any).result.content.map((part: any) => part.text ?? "").join("\n");
		const runningView = viewText(viewAt);
		expect(runningView).toContain("### VCC summary of new turns");
		expect(runningView).toContain("Status:"); expect(runningView).toContain("Model:"); expect(runningView).toContain("Background:");
		expect(runningView).not.toContain("wakeOn"); expect(runningView).not.toContain("Recent calls and results");
		expect(runningView).not.toContain("vcc_recall"); expect(Buffer.byteLength(runningView)).toBeLessThanOrEqual(8_000);
		expect(readFileSync(workerFile, "utf8")).toBe(unchangedHistory); expect(readFileSync(planPath, "utf8")).toBe(approved);
		const quietWorker = requests.worker.length, quietParent = requests.parent.length;
		const allTasks = () => JSON.parse(readFileSync(join(cwd, "scheduler.json"), "utf8")).tasks;
		const tasks = () => allTasks().filter((task: any) => task.sessionFile === workerFile);
		jobs.get("unfollowed")!.end("unfollowed-finished");
		await expect.poll(() => tasks().find((task: any) => task.name === "unfollowed")?.result?.wakeDisposition).toBe("suppressed");
		expect(requests.worker).toHaveLength(quietWorker);
		const wakeAt = worker.messages.length; jobs.get("followed")!.end("followed-finished");
		await worker.waitFor(m => m.type === "agent_settled", wakeAt);
		expect(requests.worker.length).toBeGreaterThan(quietWorker); expect(requests.parent).toHaveLength(quietParent);
		const resumedViewAt = parent.messages.length;
		await run(parent, "parent", call("worker_view", {}));
		expect(viewText(resumedViewAt)).toContain("followed-finished");
		expect(records(parentState.sessionFile, "pi-goals-report")).toHaveLength(0);
		await run(worker, "worker", ...tasks().map((task: any) => call("manage_scheduled_task", { action: "remove", id: task.id })));
		expect(tasks()).toEqual([]);
		// One stock async workflow, serial read-only helpers; no extra interactive worker.
		const discoveryAt = worker.messages.length;
		await run(worker, "worker", call("subagent", { action: "list", capabilities: true, agentScope: "project" }));
		const capability = (worker.messages.slice(discoveryAt).find(m => m.type === "tool_execution_end" && m.toolName === "subagent") as any).result.details.agentCapabilities.agents.find((agent: any) => agent.name === "fixture-helper");
		expect(capability?.executable).toBe(true);
		if (capability.runner.type === "external-cli") expect(capability.runner.available).toBe(true);
		let releaseHelper!: () => void;
		const heldHelper = new Promise<void>(done => { releaseHelper = done; });
		const helperStarted = once(server, "helper-held", { signal: AbortSignal.timeout(8_000) });
		holdRole = "helper"; hold = () => { server.emit("helper-held"); return heldHelper; };
		const helperAt = worker.messages.length;
		try {
			await run(worker, "worker", call("subagent", { async: true, context: "fork", agentScope: "project", mission: false,
				workflowScript: `const first = await runs.run('inspect', {agent:'fixture-helper',task:'Read the approved plan ${planPath}. Return HELPER_SUCCESS. No edits.',output:'inspected.md'}); const failure = await runs.run('expected-failure', {agent:'fixture-helper',task:'HELPER_EXPECTED_FAILURE: exercise a deliberate provider fault; no retry, fallback or edits.',output:'failure.md'}); return {first:first.outputReference,failure:failure.output,artifacts:failure.artifactPaths};` }));
			const launched = worker.messages.slice(helperAt).find(m => m.type === "tool_execution_end" && m.toolName === "subagent") as any;
			expect(launched.isError, JSON.stringify(launched)).not.toBe(true);
			helperId = launched.result.details.asyncId; helperDir = launched.result.details.asyncDir;
			expect(typeof helperId).toBe("string"); await helperStarted;
			await command(worker, "/goals stop");
			const pausedAt = worker.messages.length;
			await run(worker, "worker", call("subagent", { action: "status", id: helperId }), call("subagent", { agent: "fixture-helper", task: "Must stay paused", async: true }), call("subagent", { action: "resume", id: helperId, message: "Must stay paused" }));
			const pausedTools = worker.messages.slice(pausedAt).filter(m => m.type === "tool_execution_end" && m.toolName === "subagent");
			expect(pausedTools.map(m => Boolean(m.isError))).toEqual([false, true, true]); expect(requests.helper).toHaveLength(1);
			await command(worker, "/goals resume");
			const wakeAt = worker.messages.length, ownerRequests = requests.worker.length;
			releaseHelper();
			await worker.waitFor(m => m.type === "agent_settled", wakeAt);
			expect(requests.worker.length).toBeGreaterThan(ownerRequests);
			const resultAt = worker.messages.length;
			await run(worker, "worker", call("subagent", { action: "status", id: helperId }));
			const helperStatus = (worker.messages.slice(resultAt).find(m => m.type === "tool_execution_end" && m.toolName === "subagent") as any).result;
			expect(JSON.stringify(helperStatus)).toContain("HELPER_EXPECTED_FAILURE"); helperFinished = true;
			expect(helperStatus.details.workflowChildren.children.map((child: any) => child.state)).toEqual(["completed", "failed"]);
			const receipt = JSON.parse(readFileSync(helperStatus.details.workflowReceiptPath, "utf8")), output = receipt.entries.inspect.outputReference;
			const readAt = worker.messages.length;
			await run(worker, "worker", call("read", { path: output }), call("ReportGoalEvent", { kind: "progress", summary: `Inspected stock helper ${helperId}: success output ${output}; deliberate failure surfaced; no fallback or goal completion.` }));
			expect(JSON.stringify(worker.messages.slice(readAt).find(m => m.type === "tool_execution_end" && m.toolName === "read"))).toContain("HELPER_SUCCESS");
			if (process.env.PI_GOALS_TEST_EVIDENCE) cpSync(output, join(process.env.PI_GOALS_TEST_EVIDENCE, "helper-inspected.md"));
			expect(requests.helper).toHaveLength(3);
			expect(requests.helper.some(request => request.messages.some(message => message.role === "tool"))).toBe(true);
			for (const request of requests.helper) {
				expect(request.tools?.map(tool => tool.function.name)).not.toContain("write");
				expect(systemText(request)).not.toContain("You are the delegated implementation worker");
				expect(systemText(request)).not.toContain("You are the goal supervisor");
			}
			expect(readFileSync(planPath, "utf8")).toBe(approved); expect(records(parentState.sessionFile, "pi-goals-report")).toHaveLength(0);
		} finally { releaseHelper(); }
		const greeting = join(cwd, "greeting.txt");
		const workerAt = worker.messages.length;
		let releaseWorker!: () => void; const heldWorker = new Promise<void>(done => { releaseWorker = done; });
		const workerRequested = once(server, "worker-held", { signal: AbortSignal.timeout(8_000) });
		holdRole = "worker"; hold = () => { server.emit("worker-held"); return heldWorker; };
		replies.worker.push(call("write", { path: greeting, content: "helo\n" }), call("ReportGoalEvent", { kind: "progress", summary: "Greeting written; verifying." }), { fail: true });
		const workerId = records(parentState.sessionFile, "pi-goals-main-supervisor-v1").at(-1).worker.intercomId;
		try {
			await run(parent, "parent", call("intercom", { action: "send", to: workerId, message: "Explicit assignment: deliver greeting.txt per the plan, verify it and report the result." }));
			await workerRequested; await stop(parent); // lose notification while retaining the real worker history
		} finally { releaseWorker(); }
		await worker.waitFor(m => m.type === "agent_settled", workerAt);
		parent = start("parent", parentState.sessionFile); await state(parent);
		const failure = records(parentState.sessionFile, "pi-goals-worker-event").find(event => event.kind === "blocker");
		expect(failure.text).toContain("Fixture execution failed after progress");
		expect(records(parentState.sessionFile, "pi-goals-report")).toHaveLength(0); // a blocker does not choose review for the supervisor
		const failedViewAt = parent.messages.length;
		await run(parent, "parent", call("worker_view", {}));
		expect(viewText(failedViewAt)).toContain("greeting.txt");
		expect(viewText(failedViewAt)).not.toContain("Recent calls and results");

		// The supervisor steers the recoverable failure directly. No review form is created.
		const correctionAt = parent.messages.length, correctionWorkerAt = worker.messages.length;
		const statusCount = records(parentState.sessionFile, "pi-goals-worker-event").length;
		const correctedEvent = { kind: "completion", summary: `Corrected artifact: ${greeting}` };
		replies.worker.push(call("write", { path: greeting, content: "hello\n" }), call("read", { path: greeting }), call("ReportGoalEvent", correctedEvent), call("ReportGoalEvent", correctedEvent));
		await run(parent, "parent", call("intercom", { action: "send", to: workerId, message: "Replace greeting.txt with hello followed by one newline, read it back, and report completion." }));
		const correction = await workerEvent(parent, correctionAt);
		await worker.waitFor(m => m.type === "agent_settled", correctionWorkerAt);
		expect(records(parentState.sessionFile, "pi-goals-worker-event").length).toBeGreaterThan(statusCount);
		expect(correction.id).not.toBe(failure.id); expect(correction.kind).toBe("completion"); expect(correction.sessionFile).toBe(workerFile);
		expect(readFileSync(greeting, "utf8")).toBe("hello\n");
		expect(records(parentState.sessionFile, "pi-goals-report")).toHaveLength(0);

		const git = (...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
		git("init", "--quiet"); git("add", "greeting.txt");
		git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "Initial artifact");
		const revision = git("rev-parse", "HEAD");
		const form = { eventId: correction.id, goal: { path: planPath, quote: "goal: deliver greeting" }, evidence: [{ path: `git:${revision}:greeting.txt`, quote: "hello", observation: "Read the corrected greeting" }], observation: "Matches the requested greeting", unmet: "none", verdict: "accepted", continuation: "" };
		await run(parent, "parent", call("review_subagent", { ...form, evidence: [{ ...form.evidence[0], quote: "invented bytes" }] }));
		expect(records(parentState.sessionFile, "pi-goals-report")).toHaveLength(0); // invalid evidence does not select formal review
		await stop(worker);
		await run(parent, "parent", call("review_subagent", form));
		expect(records(parentState.sessionFile, "pi-goals-report").map(report => report.id)).toEqual([correction.id]);
		expect(records(parentState.sessionFile, "pi-goals-report-review")).toHaveLength(0); // selected review remains pending while delivery is unavailable
		worker = start("worker", workerFile); await state(worker);
		await run(worker, "worker", call("intercom", { action: "list" }));
		const workerCount = requests.worker.length, reviewAt = worker.messages.length;
		await run(parent, "parent", call("review_subagent", form));
		await worker.waitFor(message => message.type === "entry_appended" && (message.entry as any)?.customType === "pi-goals-report-review", reviewAt);
		await command(parent, "/goals status");
		expect(requests.worker).toHaveLength(workerCount); // acceptance does not wake or close worker
		expect(worker.process.exitCode).toBeNull(); expect(worker.process.signalCode).toBeNull();
		const savedReviews = records(workerFile, "pi-goals-report-review");
		const reviewedStatusCount = records(parentState.sessionFile, "pi-goals-worker-event").length;
		expect(savedReviews.map(r => r.verdict)).toEqual(["accepted"]);
		expect(savedReviews.map(r => r.report)).toEqual([correction.id]); // retained wire field
		expect(records(parentState.sessionFile, "pi-goals-report-review")).toEqual(savedReviews);
		const upkeepAt = requests.parent.length, ordinaryTurns = 17; // two eight-turn periods plus prompt preparation
		for (let turn = 0; turn < ordinaryTurns; turn++) await run(parent, "parent");
		expect(requests.parent.length).toBeGreaterThan(upkeepAt); // queued status delivery may coalesce ordinary prompts
		expect(requests.worker).toHaveLength(workerCount);
		const notes = entries(parentState.sessionFile).filter(entry => entry.type === "custom_message" && entry.customType === "pi-goals-upkeep");
		const delivered = upkeepNudges.filter(nudge => notes.some(entry => entry.content.includes(nudge)));
		expect(delivered.length).toBeGreaterThan(1);
		for (const nudge of delivered) expect(JSON.stringify(requests.parent)).toContain(nudge);
		await command(worker, "/fixture-reload"); // reload records liveness without waking or reopening formal review
		expect(requests.worker).toHaveLength(workerCount);
		const postReloadEvents = records(parentState.sessionFile, "pi-goals-worker-event");
		expect(postReloadEvents).toHaveLength(reviewedStatusCount + 1);
		expect(postReloadEvents.at(-1)).toMatchObject({ kind: "receipt", text: expect.stringContaining("disconnected after its recorded") });
		expect(records(workerFile, "pi-goals-report-review")).toEqual(savedReviews);
		const abortAt = worker.messages.length, abortParentAt = parent.messages.length;
		let releaseAbort!: () => void; const abortedRequest = new Promise<void>(done => { releaseAbort = done; });
		const abortRequested = once(server, "aborting", { signal: AbortSignal.timeout(8_000) });
		holdRole = "worker"; hold = () => { server.emit("aborting"); return abortedRequest; };
		worker.send({ type: "prompt", id: "interrupted", message: "Wait for the interruption fixture." });
		try { await abortRequested; worker.send({ type: "abort", id: "abort" }); await worker.waitFor(m => m.type === "agent_settled", abortAt); } finally { releaseAbort(); }
		await parent.waitFor(m => m.type === "entry_appended" && (m.entry as any)?.customType === "pi-goals-worker-event" && (m.entry as any).data.kind === "aborted", abortParentAt);
		expect(records(parentState.sessionFile, "pi-goals-report")).toHaveLength(1); // intentional interruption is not another formal review
		await command(parent, "/fixture-legacy-supersession");
		await run(parent, "parent");
		expect(systemText(requests.parent.at(-1)!)).not.toContain("Selected worker-stop reviews");
		expect(readFileSync(planPath, "utf8")).toBe(approved); // reviews never CompleteGoal

		// The Ready-created owned timer survived the existing reconnect/reload story.
		const owned = () => allTasks().find((task: any) => task.id === normalTask.id);
		expect(owned()).toMatchObject({ schedule: "2h", prompt: customCheckIn, sessionFile: parentState.sessionFile });
		expect(allTasks().filter((task: any) => task.name === checkInName)).toHaveLength(1);
		await run(worker, "worker", call("schedule_task", { name: checkInName, action: "prompt", type: "interval", schedule: "1h", scope: "session", prompt: "Foreign session check-in stays untouched." }));
		const foreign = allTasks().find((task: any) => task.sessionFile === workerFile);
		const pauseAt = parent.messages.length;
		replies.parent.push(call("list_scheduled_tasks", { includeAll: true }), call("manage_scheduled_task", { action: "disable", id: normalTask.id }));
		await command(parent, "/goals stop"); await parent.waitFor(m => m.type === "agent_settled", pauseAt);
		expect(owned().enabled).toBe(false);
		expect(records(parentState.sessionFile, "pi-goals-main-supervisor-v1").at(-1).pausedCheckIns[normalTask.id]).toBe(owned().disabledAt);
		await command(parent, "/fixture-reload");
		expect(owned()).toMatchObject({ enabled: false, schedule: "2h", prompt: customCheckIn });
		const resumeAt = parent.messages.length;
		replies.parent.push(call("list_scheduled_tasks", { includeAll: true }), call("manage_scheduled_task", { action: "enable", id: normalTask.id }));
		await command(parent, "/goals resume"); await parent.waitFor(m => m.type === "agent_settled", resumeAt);
		expect(owned()).toMatchObject({ enabled: true, schedule: "2h", prompt: customCheckIn });
		const woke = once(server, "owned-check-in", { signal: AbortSignal.timeout(8_000) }), checkInAt = parent.messages.length;
		await run(parent, "parent", call("manage_scheduled_task", { action: "update", id: normalTask.id, schedule: "1s" }), { content: "Cadence edited." }, call("worker_view", {}), call("manage_scheduled_task", { action: "update", id: normalTask.id, schedule: "2h" }));
		await woke;
		const wakeView = await parent.waitFor(m => m.type === "tool_execution_end" && m.toolName === "worker_view", checkInAt);
		await parent.waitFor(m => m.type === "agent_settled", parent.messages.indexOf(wakeView));
		expect(owned()).toMatchObject({ schedule: "2h", prompt: customCheckIn });
		expect(allTasks().find((task: any) => task.id === foreign.id)).toEqual(foreign);
		if (process.env.PI_GOALS_TEST_EVIDENCE) writeFileSync(join(process.env.PI_GOALS_TEST_EVIDENCE, "owned-check-in.json"), JSON.stringify({ initial: normalTask, afterWake: owned(), foreign }, null, 2));
		// Retain the busy-Clear discriminator: passive scheduler output can flush after five seconds.
		const task = owned();
		let release!: () => void; const held = new Promise<void>(done => { release = done; });
		const requested = once(server, "held", { signal: AbortSignal.timeout(8_000) });
		holdRole = "parent"; hold = () => { server.emit("held"); return held; };
		const count = requests.parent.length, busyAt = parent.messages.length;
		parent.send({ type: "prompt", id: "busy", message: "Wait for delayed fixture response." });
		try { await requested; await command(parent, "/goals clear"); await new Promise(done => setTimeout(done, 6_000)); } finally { release(); }
		await parent.waitFor(m => m.type === "agent_settled", busyAt);
		await parent.waitFor(m => m.type === "extension_ui_request" && m.method === "notify" && JSON.stringify(m).includes(`Removed scheduled task ${task.id}`), busyAt);
		expect(allTasks()).toEqual([foreign]);
		expect(requests.parent).toHaveLength(count + 1);
		if (process.env.PI_GOALS_TEST_EVIDENCE) {
			mkdirSync(process.env.PI_GOALS_TEST_EVIDENCE, { recursive: true });
			for (const [name, text] of Object.entries({ "requests.json": JSON.stringify(requests), "parent.jsonl": readFileSync(parentState.sessionFile, "utf8"), "worker.jsonl": readFileSync(workerFile, "utf8"), "events.json": JSON.stringify(clients.map(client => ({ pid: client.process.pid, events: client.messages, stderr: client.stderr }))) })) writeFileSync(join(process.env.PI_GOALS_TEST_EVIDENCE, name), text);
		}
	} finally {
		for (const response of jobs.values()) if (!response.writableEnded) response.end("fixture cleanup");
		if (helperId && !helperFinished && worker?.process.exitCode === null && worker.process.signalCode === null) await command(worker, `/subagents-stop ${helperId}`);
		if (process.env.PI_GOALS_TEST_EVIDENCE && helperDir && existsSync(helperDir)) {
			cpSync(helperDir, join(process.env.PI_GOALS_TEST_EVIDENCE, "helper-run"), { recursive: true });
			for (const step of JSON.parse(readFileSync(join(helperDir, "status.json"), "utf8")).steps ?? []) if (step.sessionFile && existsSync(step.sessionFile)) cpSync(step.sessionFile, join(process.env.PI_GOALS_TEST_EVIDENCE, `helper-${step.workflowKey}.jsonl`));
		}
		if (process.env.PI_GOALS_TEST_EVIDENCE) {
			mkdirSync(process.env.PI_GOALS_TEST_EVIDENCE, { recursive: true });
			writeFileSync(join(process.env.PI_GOALS_TEST_EVIDENCE, "last-attempt.json"), JSON.stringify({ requests, parent: parent.messages, worker: worker?.messages }));
		}
		for (const { process: child } of clients) if (child.exitCode === null && child.signalCode === null) { const exited = once(child, "exit"); child.kill(); await exited; }
		if (process.env.PI_GOALS_TEST_EVIDENCE) writeFileSync(join(process.env.PI_GOALS_TEST_EVIDENCE, "cleanup.json"), JSON.stringify(clients.map(({ process: child }) => ({ pid: child.pid, exitCode: child.exitCode, signalCode: child.signalCode }))));
		await new Promise<void>(done => server.close(() => done())); rmSync(cwd, { recursive: true, force: true });
	}
}, 45_000);
