import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { workerAttachment } from "../../src/prompts.js";

export default function offlineModel(pi: ExtensionAPI): void {
	pi.registerCommand("fixture-reload", { handler: async (_args, ctx) => { await ctx.reload(); } });
	// Seed OpenGoalWorker's launch binding without Herdr; attachment/delivery use real Intercom/Pi.
	pi.registerCommand("fixture-worker-binding", { handler: async (args, ctx) => {
		const current = ctx.sessionManager.getBranch().findLast(entry => entry.type === "custom" && entry.customType === "pi-goals-main-supervisor-v1");
		if (current?.type !== "custom" || (current.data as { mode?: string }).mode !== "supervising") throw new Error("Ready must precede worker allocation");
		pi.appendEntry("pi-goals-main-supervisor-v1", { ...current.data as object, worker: JSON.parse(args) });
		await ctx.reload();
	} });
	pi.registerCommand("fixture-legacy-supersession", { handler: async (_args, ctx) => {
		const entry = ctx.sessionManager.getBranch().findLast(entry => entry.type === "custom" && entry.customType === "pi-goals-main-supervisor-v1");
		if (entry?.type !== "custom") throw new Error("Missing supervisor state");
		const { plan, worker } = entry.data as any;
		const report = { plan, session: worker.intercomId, sessionFile: worker.sessionFile, requestId: worker.requestId, text: "Historical artifact" };
		pi.appendEntry("pi-goals-report", { ...report, id: "legacy:A" });
		pi.appendEntry("pi-goals-report", { ...report, id: "legacy:B", supersedes: "legacy:A" });
		pi.appendEntry("pi-goals-report-review", { id: "legacy-review", report: "legacy:B", verdict: "accepted", content: "Historical review", continuation: "" });
		await ctx.reload();
	} });
	pi.registerCommand("fixture-attachment-notice", {
		handler: (_args, ctx) => pi.sendMessage({ customType: "pi-goals-supervision", content: workerAttachment(ctx.cwd, "fixture-peer", "Attachment recorded."), display: true }, { triggerTurn: false }),
	});
	pi.registerProvider("offline", {
		baseUrl: process.env.PI_GOALS_OFFLINE_MODEL_URL!,
		apiKey: "test",
		api: "openai-completions",
		models: [{
			id: "test",
			name: "Offline test model",
			reasoning: false,
			input: ["text"],
			// Scripted action replies are not compaction replies; this story retains its history.
			contextWindow: 128_000,
			maxTokens: 1_000,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		}],
	});
}
