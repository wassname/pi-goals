import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

// Pi/gpt-6-astra: compatibility schemas only; this RPC fixture must never launch a worker.
export default function subagentSchema(pi: ExtensionAPI): void {
	for (const [name, parameters] of [
		["subagent", Type.Object({ agent: Type.String(), title: Type.String() })],
		["subagent_resume", Type.Object({ sessionFile: Type.String() })],
		["subagent_kill", Type.Object({ id: Type.String() })],
	] as const) {
		pi.registerTool({
			name, label: name, description: "Schema-only RPC fixture; do not execute.", parameters,
			async execute() { throw new Error("Worker execution forbidden in RPC review test"); },
		});
	}
}
