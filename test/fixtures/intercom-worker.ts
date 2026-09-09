import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { GoalIntercom } from "../../src/intercom.js";
import { workerView } from "../../src/worker-view.js";

export default function worker(pi: ExtensionAPI): void {
	const link = new GoalIntercom(pi);
	link.onSteer = instruction => pi.sendUserMessage(`[supervisor] ${instruction}`, { deliverAs: "steer" });
	pi.on("session_start", async (_event, ctx) => {
		link.configure("native-pair-test", "worker", ctx);
		void link.waitReady(8000).then(() => {
			link.view(workerView(ctx.sessionManager.getBranch(), "settled", true, {
				sourceSession: ctx.sessionManager.getSessionFile()!, latestDirection: "Inspect actual outputs.",
				model: "offline/test", background: "No tracked work in this fixture.",
			}), "settled", undefined, true);
		}).catch(error => { if (!link.ended) ctx.ui.notify(String(error), "error"); });
	});
}
