import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";

it("declares current entry and bundled extension resources that exist after install", () => {
	const manifest = JSON.parse(readFileSync("package.json", "utf8"));
	for (const path of manifest.pi.extensions) expect(existsSync(resolve(path)), path).toBe(true);
	for (const name of ["pi-subagents", "pi-intercom", "@jl1990/pi-scheduler"]) {
		expect(manifest.dependencies[name]).toBeTruthy();
		expect(manifest.bundleDependencies).toContain(name);
	}
	expect(JSON.parse(readFileSync("package-lock.json", "utf8")).packages[""].bundleDependencies).toEqual(manifest.bundleDependencies);
});

it.each([true, false])("prepares offline=%s without changing the source profile or launching Pi", offline => {
	const source = mkdtempSync(join(tmpdir(), "pi-goals-profile-test-"));
	const settings = { packages: [], extensions: ["./unrelated-addon.ts"], defaultProvider: "human-choice", defaultModel: "keep-this" };
	const files = { "settings.json": JSON.stringify(settings), "auth.json": "{}", "models.json": '{"providers":{}}' };
	for (const [name, text] of Object.entries(files)) writeFileSync(join(source, name), text);
	let root: string | undefined;
	try {
		// An absent source profile/SDK proves the offline route does not read or import them.
		const prepared = spawnSync(process.execPath, [resolve("scripts/prepare-trial.mjs"), offline ? "unused-sdk" : resolve("node_modules/@earendil-works/pi-coding-agent"), ...(offline ? ["--offline", "http://127.0.0.1:12345"] : [])], { encoding: "utf8", env: { ...process.env, PI_OFFLINE: "1", PI_CODING_AGENT_DIR: offline ? join(source, "absent") : source } });
		expect(prepared.status, prepared.stderr).toBe(0);
		const trial = JSON.parse(prepared.stdout); root = trial.root;
		const actual = JSON.parse(readFileSync(join(trial.agentDir, "settings.json"), "utf8"));
		const manifest = JSON.parse(readFileSync(trial.manifest, "utf8"));
		const start = readFileSync(trial.start, "utf8");
		expect(actual.packages).toEqual([resolve(".")]);
		expect(actual.extensions).toEqual(offline ? [resolve("test/fixtures/offline-model.ts")] : settings.extensions);
		expect(actual.defaultModel).toBe(offline ? "test" : settings.defaultModel);
		expect(actual.defaultProvider).toBe(offline ? "offline" : settings.defaultProvider);
		expect(manifest.profile).toBe(offline ? "offline" : "inherited");
		expect(manifest.stateFile).toBe(join(trial.root, "scheduler/tasks.json"));
		expect(start).toContain(`export PI_SCHEDULER_STATE_FILE='${manifest.stateFile}'`);
		expect(start).not.toContain("--no-tools");
		expect(start).toContain(offline ? "exec pi --model offline/test" : "exec pi\n");
		if (offline) { expect(actual.enabledModels).toEqual(["offline/test"]); expect(start).toContain("export PI_OFFLINE=1"); }
		for (const [name, text] of Object.entries(files)) expect(readFileSync(join(source, name), "utf8")).toBe(text);
		expect(JSON.parse(readFileSync(join(trial.agentDir, "auth.json"), "utf8"))).toEqual({});
		expect(JSON.parse(readFileSync(join(trial.agentDir, "models.json"), "utf8"))).toEqual({ providers: {} });
	} finally { if (root) rmSync(root, { recursive: true, force: true }); rmSync(source, { recursive: true, force: true }); }
});
