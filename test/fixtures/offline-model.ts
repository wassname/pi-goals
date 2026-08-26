import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function offlineModel(pi: ExtensionAPI): void {
	pi.registerProvider("offline", {
		baseUrl: process.env.PI_GOALS_OFFLINE_MODEL_URL!,
		apiKey: "test",
		api: "openai-completions",
		models: [{
			id: "test",
			name: "Offline test model",
			reasoning: false,
			input: ["text"],
			contextWindow: 16_000,
			maxTokens: 1_000,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		}],
	});
}
