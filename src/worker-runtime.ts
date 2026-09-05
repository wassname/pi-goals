import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const PREPARED_FORK = "pi-goals-worker-fork-prepared";

export default function workerRuntime(pi: ExtensionAPI): void {
	pi.on("session_start", async (_event, ctx) => {
		const prepared = ctx.sessionManager
			.getEntries()
			.some((entry: { type?: string; customType?: string }) => entry.type === "custom" && entry.customType === PREPARED_FORK);
		if (prepared) return;
		await new Promise<void>((resolve, reject) => {
			ctx.compact({
				customInstructions: "__pi_vcc__ keep:0",
				onComplete: (result) => {
					if ((result.details as { compactor?: string } | undefined)?.compactor !== "pi-vcc") {
						reject(new Error("Goal-worker fork was not compacted by pi-vcc."));
						return;
					}
					pi.appendEntry(PREPARED_FORK, { version: 1, compacted: true, compactor: "pi-vcc" });
					resolve();
				},
				onError: (error) => {
					if (error.message !== "Nothing to compact (session too small)") {
						reject(error);
						return;
					}
					pi.appendEntry(PREPARED_FORK, { version: 1, compacted: false, reason: "below-compactable-size" });
					resolve();
				},
			});
		});
	});
}
