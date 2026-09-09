// Read-only replay of recorded research branches. Run from the pi-goals root after npm run build.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import ts from "typescript";

const output = "slop/reviews/vcc-view";
const root = "/home/code/.pi/agent/sessions/--workspace-2026-mfv-manifold-steer--/";
const workerPath = `${root}2026-09-08T10-41-19-145Z_01a0809b-a528-7724-a514-59f3c61116a6.jsonl`;
const supervisorPath = `${root}2026-09-08T22-43-35-654Z_01a08330-e866-7004-9b7f-5efdceb2488e.jsonl`;
const load = path => readFileSync(path, "utf8").trim().split("\n").map(line => JSON.parse(line));
const entries = load(workerPath);
const byId = new Map(entries.map(entry => [entry.id, entry]));
const records = load(supervisorPath);
const oldSource = execFileSync("git", ["show", "8953dce:src/worker-view.ts"], { encoding: "utf8" });
const oldCode = ts.transpileModule(oldSource, { compilerOptions: { module: ts.ModuleKind.ES2022 } }).outputText;
const { workerView: oldView } = await import(`data:text/javascript;base64,${Buffer.from(oldCode).toString("base64")}`);
const piRequire = createRequire(import.meta.resolve("@earendil-works/pi-coding-agent"));
const { createJiti } = piRequire("jiti");
const jiti = createJiti(import.meta.url, { moduleCache: false, fsCache: false });
const { workerView: newView } = await jiti.import(resolve("src/worker-view.ts"));
const { workerView: builtView } = await jiti.import(resolve("dist/worker-view.js"));
const results = [];
for (const [name, through] of [["pilot-preparation", "3cb9b26f"], ["flow-implementation", "69943231"], ["settled-checkpoint", "e266d41e"]]) {
	const record = records.find(entry => entry.customType === "pi-goals-intercom" && entry.data.message.kind === "view" && entry.data.message.through === through);
	assert(record, `recorded view ${through}`);
	const message = record.data.message;
	const branch = [];
	for (let entry = byId.get(through); entry; entry = byId.get(entry.parentId)) branch.unshift(entry);
	assert(branch.length, "nonempty live branch");
	const ack = branch.filter(entry => entry.customType === "pi-goals-intercom" && entry.data.direction === "ack" && entry.data.message.through).at(-1);
	const context = {
		sourceSession: workerPath,
		model: message.text.match(/^worker model: (.*)$/m)[1],
		latestDirection: message.text.match(/latest human direction:\n([\s\S]*?)\ntool calls with no result:/)[1],
		background: message.text.match(/^tracked background work: (.*)$/m)[1],
		since: ack?.data.message.through,
	};
	const args = [branch, message.reason, message.text.startsWith("The worker stopped."), context];
	const before = oldView(...args);
	const after = newView(...args);
	assert.equal(builtView(...args), after, "built/source real compiler parity");
	const envelope = { binding: message.binding, role: "worker", kind: "view", id: message.id, text: after, reason: message.reason, through, backgroundQuiet: message.backgroundQuiet };
	assert(Buffer.byteLength(JSON.stringify(envelope)) < 16_000, "serialized transport bound");
	// Normalize only the saved files' trailing blank lines; byte metrics use the exact rendered strings.
	writeFileSync(`${output}/${name}-old.md`, before.trimEnd() + "\n");
	writeFileSync(`${output}/${name}-vcc.md`, after.trimEnd() + "\n");
	results.push({ name, timestamp: record.timestamp, through, since: context.since, branchEntries: branch.length, branchSha256: createHash("sha256").update(JSON.stringify(branch)).digest("hex"), oldBytes: Buffer.byteLength(before), vccBytes: Buffer.byteLength(after), oldSerializedTextBytes: Buffer.byteLength(JSON.stringify(before)), vccSerializedTextBytes: Buffer.byteLength(JSON.stringify(after)), envelopeBytes: Buffer.byteLength(JSON.stringify(envelope)) });
}
const manifest = { baseline: "8953dce", workerPath, supervisorPath, compiler: "@sting8k/pi-vcc@0.5.0", results };
writeFileSync(`${output}/comparison.json`, JSON.stringify(manifest, null, 2) + "\n");
console.log(JSON.stringify(manifest, null, 2));
console.log("PASS: three identical historical branch/ack windows, serialized bounds, source and built compiler execution agree.");
