import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { GoalIntercom } from "../../src/intercom.js";

export default function worker(pi: ExtensionAPI): void {
	const link = new GoalIntercom(pi);
	link.onSteer = instruction => pi.sendUserMessage(`[supervisor] ${instruction}`, { deliverAs: "steer" });
	pi.on("session_start", async (_event, ctx) => {
		link.configure("native-pair-test", "worker", ctx);
		void link.waitReady(8000).then(() => {
			link.view("The worker stopped.\n\nThe saved plan needs a check of the actual outputs.", "settled", undefined, true);
		}).catch(error => { if (!link.ended) ctx.ui.notify(String(error), "error"); });
	});
}
