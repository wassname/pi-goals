// Pi/OpenAI: Collapse only the display; the saved user prompt and model input stay unchanged.
import { type ExtensionAPI, type ExtensionContext, getMarkdownTheme, keyHint } from "@earendil-works/pi-coding-agent";
import { Markdown, truncateToWidth } from "@earendil-works/pi-tui";

const NOTICE = "pi-goals-notice";

export function noticeDisplay(pi: ExtensionAPI) {
	const mirrored = new Set<string>();
	pi.registerMarkdownTransformer((markdown, context) =>
		context.messageType === "user" && mirrored.has(markdown) ? "" : markdown);
	pi.registerEntryRenderer(NOTICE, (entry, { expanded }, theme) => {
		const { content } = entry.data as { content: string };
		const label = content.includes("\nPlan changed.") ? "Plan changed · review requested" : "Goal instructions";
		if (expanded) return new Markdown(content, 0, 0, getMarkdownTheme());
		return {
			render: (width) => [truncateToWidth(theme.fg("muted", `[pi-goals] ${label} · ${keyHint("app.tools.expand", "expand")}`), width)],
			invalidate() {},
		};
	});
	return {
		mirror(content: string) {
			mirrored.add(content);
			pi.appendEntry(NOTICE, { content });
		},
		restore(ctx: ExtensionContext) {
			mirrored.clear();
			for (const entry of ctx.sessionManager.getBranch()) {
				if (entry.type === "custom" && entry.customType === NOTICE) mirrored.add((entry.data as { content: string }).content);
			}
		},
	};
}
