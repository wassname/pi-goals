import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type ExtensionAPI, type ExtensionContext, getAgentDir } from "@earendil-works/pi-coding-agent";

export type ModelRole = "planning" | "worker" | "supervisor";
export interface ModelChoice { provider: string; id: string }

/** One atomic file per role: a supervisor process cannot clobber the worker's choice. */
export class RoleModels {
	private role: ModelRole | null = null;
	private automatic = 0;
	private available = true;

	constructor(private pi: ExtensionAPI, private directory = join(getAgentDir(), "pi-goals")) {
		pi.on("model_select", (event, ctx) => {
			// setModel can emit "set" itself. Session restore is not a human preference either.
			if (this.automatic || event.source === "restore" || !this.role) return;
			try { this.save(this.role, event.model); this.available = true; }
			catch (error) { ctx.ui.notify(`Could not remember ${this.role} model: ${String(error)}`, "error"); }
		});
	}

	get ready(): boolean { return this.available; }
	get activeRole(): ModelRole | null { return this.role; }
	get restoring(): boolean { return this.automatic > 0; }
	leave(): void { this.role = null; this.available = true; }

	/** Explicit acknowledgement works even when Pi suppresses same-model model_select. */
	async useCurrent(ctx: ExtensionContext): Promise<boolean> {
		const role = this.role;
		if (!role || this.available) { ctx.ui.notify("No role model is paused.", "info"); return false; }
		this.automatic++;
		try {
			const model = ctx.model;
			if (!model || !await this.pi.setModel(model)) throw new Error("The current model is missing or unauthenticated");
			this.save(role, model);
			this.available = true;
			ctx.ui.notify(`Explicitly saved current model ${model.provider}/${model.id} for ${role}.`, "info");
			return true;
		} catch (error) {
			ctx.ui.notify(`Could not recover ${role}: ${String(error)}. Saved choice unchanged.`, "error");
			return false;
		} finally { this.automatic--; }
	}

	private path(role: ModelRole): string { return join(this.directory, `${role}-model.json`); }
	private read(role: ModelRole): ModelChoice | undefined {
		let raw: string;
		try { raw = readFileSync(this.path(role), "utf8"); }
		catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
		const value = JSON.parse(raw);
		if (!value || typeof value.provider !== "string" || !value.provider || typeof value.id !== "string" || !value.id) throw new Error(`Invalid model preference: ${this.path(role)}`);
		return { provider: value.provider, id: value.id };
	}
	private save(role: ModelRole, model: ModelChoice): void {
		mkdirSync(this.directory, { recursive: true });
		const temp = `${this.path(role)}.${randomUUID()}.tmp`;
		try {
			writeFileSync(temp, `${JSON.stringify({ provider: model.provider, id: model.id })}\n`, { mode: 0o600 });
			renameSync(temp, this.path(role));
		} finally { rmSync(temp, { force: true }); }
	}

	/** Failure keeps the saved choice and pauses the role; only an explicit selection replaces it. */
	async enter(role: ModelRole, ctx: ExtensionContext): Promise<boolean> {
		this.role = role;
		this.automatic++;
		try {
			const choice = this.read(role);
			if (!choice) {
				if (!ctx.model) throw new Error("No current model. Select one with /model first.");
				this.save(role, ctx.model);
				if (!await this.pi.setModel(ctx.model)) throw new Error(`Current model ${ctx.model.provider}/${ctx.model.id} has no authentication.`);
			} else {
				const model = ctx.modelRegistry.find(choice.provider, choice.id);
				if (!model) throw new Error(`Remembered model ${choice.provider}/${choice.id} is unavailable.`);
				if (!await this.pi.setModel(model)) throw new Error(`Remembered model ${choice.provider}/${choice.id} has no authentication.`);
			}
			this.available = true;
			return true;
		} catch (error) {
			this.available = false;
			ctx.ui.notify(`${role} model paused: ${String(error)} Saved choice unchanged; configure that model and retry, select a different model with /model, or explicitly use the current model for this paused role with /goals model current. Then retry Ready if work has not started.`, "error");
			return false;
		} finally { this.automatic--; }
	}
}
