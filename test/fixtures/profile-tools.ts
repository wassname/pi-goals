import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

// Auto-discovered by the isolated native supervisor profile, not passed with -e.
export default function profileTools(pi: ExtensionAPI) {
	pi.registerTool({
		name: "profile_inspection",
		label: "Profile inspection",
		description: "Inspect the test profile marker.",
		parameters: Type.Object({}),
		async execute() {
			return { content: [{ type: "text", text: "Profile loaded." }], details: {} };
		},
	});
}
