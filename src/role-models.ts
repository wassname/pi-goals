import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

export type ModelRole = "planning" | "worker" | "supervisor";
interface Choice { provider: string; id: string }

// Pi/OpenAI: Per-role model memory, adapted from cecb1e9; preferences stay in the project.
export class RoleModels {
	private role?: ModelRole;
	private ctx?: ExtensionContext;
	private switching = false;
	private stopped = false;

	constructor(private pi: ExtensionAPI) {
		pi.on("session_shutdown", async () => { this.stopped = true; this.leave(); });
		pi.on("model_select", async (event) => {
			if (this.switching || event.source === "restore" || !this.role || !this.ctx) return;
			this.save(this.role, this.ctx, event.model);
		});
	}

	leave(): void { this.role = undefined; }

	async enter(role: ModelRole, ctx: ExtensionContext, useCurrent = false): Promise<void> {
		if (this.stopped) throw new Error("Role model session ended.");
		this.role = role;
		this.ctx = ctx;
		let choice: Choice | undefined;
		if (!useCurrent) {
			try { choice = JSON.parse(readFileSync(this.path(role, ctx), "utf8")); }
			catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
		}
		if (choice && (!choice.provider || !choice.id)) throw new Error(`Invalid saved ${role} model.`);
		const model = choice ? ctx.modelRegistry.find(choice.provider, choice.id) : ctx.model;
		if (!model) throw new Error(`${role} model is unavailable. Select an available model with /model, then retry. Saved choice was not replaced.`);
		this.switching = true;
		try {
			if (!await this.pi.setModel(model)) throw new Error(`${role} model ${model.provider}/${model.id} is unavailable or unauthenticated. Saved choice was not replaced.`);
			if (this.stopped) throw new Error("Role model session ended.");
			this.save(role, ctx, model);
			ctx.ui.notify(`${role} model: ${model.provider}/${model.id}`, "info");
		} finally { this.switching = false; }
	}

	private path(role: ModelRole, ctx: ExtensionContext): string {
		return join(ctx.cwd, ".pi", "pi-goals", "models", `${role}.json`);
	}
	private save(role: ModelRole, ctx: ExtensionContext, model: Choice): void {
		const path = this.path(role, ctx);
		mkdirSync(join(ctx.cwd, ".pi", "pi-goals", "models"), { recursive: true });
		const temporary = `${path}.${process.pid}.tmp`;
		writeFileSync(temporary, `${JSON.stringify({ provider: model.provider, id: model.id })}\n`);
		renameSync(temporary, path);
	}
}
