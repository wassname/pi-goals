// Pi/OpenAI: Pi converts routine custom notices to the same user-role model input; legacy mirrored prompts remain exact.
import { type ExtensionAPI, type ExtensionContext, getMarkdownTheme, keyHint } from "@earendil-works/pi-coding-agent";
import { Markdown, truncateToWidth } from "@earendil-works/pi-tui";

const NOTICE = "pi-goals-notice";
const PROMPT = "pi-goals-prompt";
const COMPACT = "pi-goals-compact-prompt";

function noticeLabel(content: string) {
	return content.includes("[pi-goals: plan activity]") ? "Plan activity recorded"
		: content.includes("\nPlan requirements or goal status changed") ? "Plan changed · review requested"
		: content.includes("\nPlan changed") ? "Plan changed · review requested"
		: content.includes("## Selected worker-stop reviews") ? "Selected worker-stop reviews"
		: content.includes("## Worker stop review:") ? "Worker stop review"
		: content.includes("## Worker status:") ? "Worker status"
		: "Goal instructions";
}

export function noticeDisplay(pi: ExtensionAPI) {
	const mirrored = new Set<string>();
	const compacted = new Set<string>();
	pi.registerMarkdownTransformer((markdown, context) => {
		if (context.messageType !== "user") return markdown;
		if (compacted.has(markdown)) return `[pi-goals] ${noticeLabel(markdown)}`;
		return mirrored.has(markdown) ? "" : markdown;
	});
	const render = (content: string, expanded: boolean, theme: { fg(color: string, text: string): string }) => {
		if (expanded) return new Markdown(content, 0, 0, getMarkdownTheme());
		return {
			render: (width: number) => [truncateToWidth(theme.fg("muted", `[pi-goals] ${noticeLabel(content)} · ${keyHint("app.tools.expand", "expand")}`), width)],
			invalidate() {},
		};
	};
	pi.registerEntryRenderer(NOTICE, (entry, { expanded }, theme) => render((entry.data as { content: string }).content, expanded, theme));
	pi.registerMessageRenderer(PROMPT, (message, { expanded }, theme) => render(typeof message.content === "string" ? message.content : message.content.filter(part => part.type === "text").map(part => part.text).join("\n"), expanded, theme));
	return {
		prompt(content: string) {
			pi.sendMessage({ customType: PROMPT, content, display: true }, { triggerTurn: true, deliverAs: "followUp" });
		},
		passive(content: string) {
			pi.sendMessage({ customType: PROMPT, content, display: true }, { deliverAs: "nextTurn" });
		},
		hide(content: string) {
			mirrored.add(content);
		},
		mirror(content: string) {
			mirrored.add(content);
			pi.appendEntry(NOTICE, { content });
		},
		compact(content: string) {
			compacted.add(content);
			pi.appendEntry(COMPACT, { content });
		},
		restore(ctx: ExtensionContext, hiddenTypes: string[] = []) {
			mirrored.clear();
			compacted.clear();
			for (const entry of ctx.sessionManager.getBranch()) {
				if (entry.type !== "custom") continue;
				const compact = entry.customType === COMPACT;
				const mirroredType = entry.customType === NOTICE || hiddenTypes.includes(entry.customType);
				if (!compact && !mirroredType) continue;
				const content = (entry.data as { content?: unknown }).content;
				if (typeof content !== "string") continue;
				if (compact) compacted.add(content);
				else mirrored.add(content);
			}
		},
	};
}
