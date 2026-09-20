// Pi/OpenAI: Pi converts routine custom notices to the same user-role model input; legacy mirrored prompts remain exact.
import { type ExtensionAPI, type ExtensionContext, getMarkdownTheme, keyHint } from "@earendil-works/pi-coding-agent";
import { Markdown, truncateToWidth } from "@earendil-works/pi-tui";

const NOTICE = "pi-goals-notice";
const PROMPT = "pi-goals-prompt";

export function noticeDisplay(pi: ExtensionAPI) {
	const mirrored = new Set<string>();
	pi.registerMarkdownTransformer((markdown, context) =>
		context.messageType === "user" && mirrored.has(markdown) ? "" : markdown);
	const render = (content: string, expanded: boolean, theme: { fg(color: string, text: string): string }) => {
		const label = content.includes("\nPlan changed") ? "Plan changed · review requested"
			: content.includes("## Worker revision reviews") ? "Worker revisions · review requested"
			: content.includes("## Worker revision report") ? "Worker revision report"
			: content.includes("## Worker status:") ? "Worker status"
			: "Goal instructions";
		if (expanded) return new Markdown(content, 0, 0, getMarkdownTheme());
		return {
			render: (width: number) => [truncateToWidth(theme.fg("muted", `[pi-goals] ${label} · ${keyHint("app.tools.expand", "expand")}`), width)],
			invalidate() {},
		};
	};
	pi.registerEntryRenderer(NOTICE, (entry, { expanded }, theme) => render((entry.data as { content: string }).content, expanded, theme));
	pi.registerMessageRenderer(PROMPT, (message, { expanded }, theme) => render(typeof message.content === "string" ? message.content : message.content.filter(part => part.type === "text").map(part => part.text).join("\n"), expanded, theme));
	return {
		prompt(content: string) {
			pi.sendMessage({ customType: PROMPT, content, display: true }, { triggerTurn: true, deliverAs: "followUp" });
		},
		hide(content: string) {
			mirrored.add(content);
		},
		mirror(content: string) {
			mirrored.add(content);
			pi.appendEntry(NOTICE, { content });
		},
		restore(ctx: ExtensionContext, hiddenTypes: string[] = []) {
			mirrored.clear();
			for (const entry of ctx.sessionManager.getBranch()) {
				if (entry.type !== "custom" || entry.customType !== NOTICE && !hiddenTypes.includes(entry.customType)) continue;
				const content = (entry.data as { content?: unknown }).content;
				if (typeof content === "string") mirrored.add(content);
			}
		},
	};
}
