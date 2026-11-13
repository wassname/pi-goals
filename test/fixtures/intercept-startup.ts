// PI/OpenAI: use the real lifecycle and scheduler, but intercept prompts before any model request.
import { writeFileSync } from "node:fs";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

export default function fixture(pi: ExtensionAPI) {
	const state = (ctx: ExtensionContext) => ctx.sessionManager.getBranch().filter(e => e.type === "custom" && e.customType === "pi-goals-single-agent").at(-1);
	pi.on("input", event => {
		pi.sendMessage({ customType: "fixture-input", content: event.text, display: false });
		return { action: "handled" };
	});
	pi.registerCommand("fixture-seed", { description: "Seed an integration goals file", handler: async (_args, ctx) => {
		const entry = state(ctx);
		if (entry?.type !== "custom") throw new Error("No goals state");
		writeFileSync((entry.data as { file: string }).file, "# Integration\n\nA verified result.\n\n## Goals\n\n1. [/] goal: make the result\n\n## Loop statement\n\nKeep working.\n");
	} });
	pi.registerCommand("fixture-state", { description: "Record integration goals state", handler: async (_args, ctx) => {
		pi.sendMessage({ customType: "fixture-runtime", content: JSON.stringify(process.versions), display: false });
		pi.sendMessage({ customType: "fixture-state", content: "state", details: state(ctx), display: false });
	} });
}
