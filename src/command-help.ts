import type { AutocompleteItem } from "@earendil-works/pi-tui";

const workerCommands: Record<string, string> = {
	work: "Reconnect the existing approved worker pairing (not a role conversion)",
	supervise: "Use in the saved supervisor pane to reconnect it",
	solo: "Continue an approved plan unsupervised; supervisor sign-off unavailable",
	noplan: "Exit planning; preserve the draft without approving implementation",
	reconnect: "Retry the existing pairing/model; never replace its pane",
	restart: "Replace the tracked supervisor and restore supervision; preserve the plan",
	clear: "Close the tracked supervisor and disconnect the plan; keep its file",
	model: "Select the supervisor model: /goals model <model>",
};

export function goalCommandCompletions(prefix: string, role: "worker" | "supervisor"): AutocompleteItem[] | null {
	const commands = role === "worker" ? workerCommands : {
		supervise: "Reconnect this saved supervisor role and pairing",
		reconnect: "Retry this supervisor's model and existing pairing",
	};
	const matches = Object.entries(commands).filter(([value]) => value.startsWith(prefix)).map(([value, description]) => ({ value, label: value, description }));
	return matches.length ? matches : null;
}
