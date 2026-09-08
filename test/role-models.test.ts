import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { type ModelChoice, type ModelRole, RoleModels } from "../src/role-models.js";

function harness(directory: string, current: ModelChoice = { provider: "initial", id: "model" }) {
	let selected: any;
	const ctx = { model: current, modelRegistry: { find: vi.fn((provider: string, id: string) => ({ provider, id })) }, ui: { notify: vi.fn() } };
	const pi = {
		on(_name: string, handler: any) { selected = handler; },
		setModel: vi.fn(async (model: ModelChoice) => { const previousModel = ctx.model; ctx.model = model; if (previousModel.provider !== model.provider || previousModel.id !== model.id) selected({ source: "set", previousModel, model }, ctx); return true; }),
	};
	const models = new RoleModels(pi as unknown as ExtensionAPI, directory);
	return {
		models, ctx, pi,
		enter: (role: ModelRole) => models.enter(role, ctx as unknown as ExtensionContext),
		select: (source: "set" | "cycle" | "restore", model: ModelChoice) => { ctx.model = model; selected({ source, model }, ctx); },
	};
}
const stored = (dir: string, role: string) => JSON.parse(readFileSync(join(dir, `${role}-model.json`), "utf8"));

describe("role-models storage and public model_select", () => {
	it("inherits current on first use, remembers set/cycle independently, and ignores automatic set and restore", async () => {
		const dir = join(process.env.PI_CODING_AGENT_DIR!, "pi-goals");
		const h = harness(dir);
		for (const role of ["planning", "worker", "supervisor"] as const) {
			const inherited = { ...h.ctx.model };
			expect(await h.enter(role)).toBe(true);
			expect(stored(dir, role)).toEqual(inherited);
			h.select(role === "planning" ? "set" : "cycle", { provider: role, id: `${role}-choice` });
		}
		for (const role of ["planning", "worker", "supervisor"] as const) {
			expect(await h.enter(role)).toBe(true);
			expect(h.ctx.model).toEqual({ provider: role, id: `${role}-choice` });
			h.select("restore", { provider: "session", id: "old" });
			expect(stored(dir, role)).toEqual({ provider: role, id: `${role}-choice` });
		}
		h.models.leave(); h.select("cycle", { provider: "outside", id: "unrelated" });
		expect(stored(dir, "supervisor").provider).toBe("supervisor");
	});

	it("restores after a fresh instance/process and avoids cross-role lost updates", async () => {
		const dir = join(process.env.PI_CODING_AGENT_DIR!, "pi-goals");
		const h = harness(dir);
		await h.enter("planning"); h.select("cycle", { provider: "planner", id: "persisted" });
		// Two cold Pi/tsx imports compete with the packed-session tests in the full suite.
		await Promise.all(["worker", "supervisor"].map(role => promisify(execFile)(process.execPath, ["--import", "tsx", resolve("test/fixtures/role-model-process.ts"), dir, role, `${role}-provider`, "persisted"], { timeout: 20_000 })));
		const fresh = harness(dir, { provider: "unrelated", id: "start" });
		for (const role of ["planning", "worker", "supervisor"] as const) {
			await fresh.enter(role);
			expect(fresh.ctx.model).toEqual({ provider: role === "planning" ? "planner" : `${role}-provider`, id: "persisted" });
			expect(Object.keys(stored(dir, role))).toEqual(["provider", "id"]);
		}
	}, 30_000);

	it.each(["unavailable", "unauthenticated"])("visibly pauses a %s remembered model without replacing it", async failure => {
		const dir = join(process.env.PI_CODING_AGENT_DIR!, "pi-goals");
		const h = harness(dir); await h.enter("worker");
		h.select("set", { provider: "chosen", id: "keep" });
		const fresh = harness(dir, { provider: "other-provider", id: "fallback" });
		if (failure === "unavailable") fresh.ctx.modelRegistry.find.mockReturnValue(undefined as any);
		else fresh.pi.setModel.mockResolvedValue(false);
		expect(await fresh.enter("worker")).toBe(false);
		expect(fresh.models.ready).toBe(false);
		expect(fresh.ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("Saved choice unchanged"), "error");
		expect(fresh.ctx.model.provider).toBe("other-provider");
		expect(stored(dir, "worker")).toEqual({ provider: "chosen", id: "keep" });
		fresh.select("restore", { provider: "fallback", id: "automatic" });
		expect(stored(dir, "worker").provider).toBe("chosen");
		fresh.select("cycle", { provider: "explicit", id: "replacement" });
		expect(fresh.models.ready).toBe(true);
		expect(stored(dir, "worker").provider).toBe("explicit");
	});
});


it("explicit use-current recovers the paused role when same-model selection emits no event", async () => {
	const dir = join(process.env.PI_CODING_AGENT_DIR!, "pi-goals");
	const h = harness(dir); await h.enter("worker"); h.select("set", { provider: "missing", id: "worker-choice" });
	const fresh = harness(dir, { provider: "current", id: "working-model" });
	fresh.ctx.modelRegistry.find.mockReturnValue(undefined as any);
	expect(await fresh.enter("worker")).toBe(false);
	await fresh.pi.setModel(fresh.ctx.model); // Real Pi suppresses this model_select.
	expect(fresh.models.ready).toBe(false);
	expect(stored(dir, "worker").provider).toBe("missing");
	fresh.pi.setModel.mockResolvedValueOnce(false);
	expect(await fresh.models.useCurrent(fresh.ctx as unknown as ExtensionContext)).toBe(false);
	expect(stored(dir, "worker").provider).toBe("missing");
	expect(await fresh.models.useCurrent(fresh.ctx as unknown as ExtensionContext)).toBe(true);
	expect(fresh.models.activeRole).toBe("worker");
	expect(fresh.models.ready).toBe(true);
	expect(stored(dir, "worker")).toEqual({ provider: "current", id: "working-model" });
});
