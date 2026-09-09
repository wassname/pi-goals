import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { GoalIntercom } from "../../src/intercom.js";
import { intercomFixture } from "../intercom-fixture.js";

// Real Pi owns compaction; only the external transport is deterministic in this fixture.
export default function compactionDelivery(pi: ExtensionAPI) {
	const wire = intercomFixture();
	const link = new GoalIntercom({ ...pi, events: wire.events } as ExtensionAPI);
	const role = process.env.PI_GOALS_TEST_DELIVERY_ROLE === "worker" ? "worker" : "supervisor";
	link.onSteer = text => pi.sendUserMessage(`[supervisor] ${text}`, { deliverAs: "steer" });
	link.onView = view => pi.sendUserMessage(view.text, { deliverAs: "followUp" });
	pi.on("session_start", async (_event, ctx) => link.configure("compaction-pair", role, ctx, true));
	pi.on("session_before_compact", async event => {
		wire.receive({ binding: "compaction-pair", role: role === "worker" ? "supervisor" : "worker", kind: role === "worker" ? "steer" : "view", id: "retained-evidence", text: "Retained evidence arrived during manual compaction.", reason: "settled" });
		await new Promise(resolve => setTimeout(resolve, 100));
		if (process.env.PI_GOALS_TEST_COMPACTION === "cancel") return { cancel: true };
		if (process.env.PI_GOALS_TEST_COMPACTION === "failure") return; // Local model fails only its summarization request.
		return { compaction: { summary: "Previous task and result preserved.", firstKeptEntryId: event.preparation.firstKeptEntryId, tokensBefore: event.preparation.tokensBefore } };
	});
}
