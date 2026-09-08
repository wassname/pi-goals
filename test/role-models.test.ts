import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { expect, it, vi } from "vitest";
import { RoleModels } from "../src/role-models.js";

function runtime(cwd: string) {
	const hooks = new Map<string, any>();
	const ctx = { cwd, model: { provider: "test", id: "planner" }, modelRegistry: { find: vi.fn((provider: string, id: string): any => ({ provider, id })) }, ui: { notify: vi.fn() } };
	const pi = {
		on: (name: string, fn: any) => hooks.set(name, fn),
		setModel: vi.fn(async (model: any) => { ctx.model = model; await hooks.get("model_select")({ source: "set", model }); return true; }),
	};
	const models = new RoleModels(pi as unknown as ExtensionAPI);
	return { models, ctx, pi, hooks, select: async (id: string, source = "set") => { ctx.model = { provider: "test", id }; await hooks.get("model_select")({ source, model: ctx.model }); } };
}

it("remembers each role without automatic switching overwriting another role", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "goals-role-models-"));
	try {
		const first = runtime(cwd);
		await first.models.enter("planning", first.ctx as any);
		await first.models.enter("worker", first.ctx as any);
		await first.select("small-worker");
		await first.models.enter("supervisor", first.ctx as any);
		await first.select("astra");
		await first.models.enter("planning", first.ctx as any);
		expect(first.ctx.model.id).toBe("planner");
		const resumed = runtime(cwd);
		await resumed.models.enter("worker", resumed.ctx as any);
		expect(resumed.ctx.model.id).toBe("small-worker");
		await resumed.models.enter("supervisor", resumed.ctx as any);
		expect(resumed.ctx.model.id).toBe("astra");
		await resumed.select("restored-default", "restore");
		expect(JSON.parse(readFileSync(join(cwd, ".pi/pi-goals/models/supervisor.json"), "utf8")).id).toBe("astra");
		console.log("Role preferences restored: planning=planner, worker=small-worker, supervisor=astra; restore events did not overwrite the choice.");
	} finally { rmSync(cwd, { recursive: true, force: true }); }
});

it("fails on an unavailable remembered model without replacing the choice", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "goals-role-unavailable-"));
	try {
		const first = runtime(cwd);
		await first.models.enter("supervisor", first.ctx as any);
		await first.select("astra");
		const path = join(cwd, ".pi/pi-goals/models/supervisor.json");
		const saved = readFileSync(path, "utf8");
		const resumed = runtime(cwd);
		resumed.ctx.modelRegistry.find.mockReturnValue(undefined);
		await expect(resumed.models.enter("supervisor", resumed.ctx as any)).rejects.toThrow("unavailable");
		expect(resumed.pi.setModel).not.toHaveBeenCalled();
		expect(readFileSync(path, "utf8")).toBe(saved);
		await resumed.models.enter("supervisor", resumed.ctx as any, true);
		expect(JSON.parse(readFileSync(path, "utf8")).id).toBe("planner");
		resumed.models.leave();
		await resumed.select("unrelated-model");
		expect(JSON.parse(readFileSync(path, "utf8")).id).toBe("planner");
	} finally { rmSync(cwd, { recursive: true, force: true }); }
});
