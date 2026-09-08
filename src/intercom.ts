import type { ExtensionAPI, ExtensionContext, SessionStartEvent } from "@earendil-works/pi-coding-agent";

/** Compose the bundled transport only after every installed extension has had a chance to register.
 * An existing Intercom owns its own lifecycle. The fallback owns just its initial session_start;
 * all subsequent hooks use Pi's public extension API normally (reload creates a fresh instance).
 */
export async function loadBundledIntercom(pi: ExtensionAPI, event: SessionStartEvent, ctx: ExtensionContext): Promise<void> {
	if (pi.getAllTools().some(tool => tool.name === "intercom")) throw new Error("Installed Intercom has no extension channel. Enable/update that installation and reload; no second Intercom was loaded.");
	const starts: Array<(event: SessionStartEvent, ctx: ExtensionContext) => unknown> = [];
	const api = { ...pi, on(name: string, handler: (...args: any[]) => any) {
		if (name === "session_start") starts.push(handler);
		else pi.on(name as Parameters<ExtensionAPI["on"]>[0], handler);
	} } as ExtensionAPI;
	const { default: intercom } = await import("pi-intercom");
	intercom(api);
	for (const start of starts) await start(event, ctx);
}
