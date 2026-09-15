// Nico publishes TypeScript source, not declarations; its transitive internal graph
// targets a different Pi SDK. Type only the public v1 operation used here.
declare module "pi-subagents/project-panes" {
	export function openProjectPane(options: { cwd: string; message?: string; focus?: boolean; signal?: AbortSignal }): Promise<
		| { ok: true; data: { bindingPath: string; disposition: "opened" | "already-open"; binding: { paneId: string; projectRoot: string; command: string } } }
		| { ok: false; error: { code: string; message: string } }
	>;
}
