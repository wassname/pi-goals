import { type ExtensionAPI, type ExtensionContext, getMarkdownTheme, initTheme } from "@earendil-works/pi-coding-agent";
import { Markdown, visibleWidth } from "@earendil-works/pi-tui";
import { expect, it, vi } from "vitest";
import { noticeDisplay } from "../src/notice-display.js";

it("collapses mirrored prompts only in the UI, expands the exact text, and restores by branch", () => {
	initTheme("dark");
	const theme = { fg: (_color: string, text: string) => text };
	const pi = { registerMarkdownTransformer: vi.fn(), registerEntryRenderer: vi.fn(), appendEntry: vi.fn() };
	const display = noticeDisplay(pi as unknown as ExtensionAPI);
	const transform = pi.registerMarkdownTransformer.mock.calls[0][0];
	const render = pi.registerEntryRenderer.mock.calls[0][1];
	const content = "[pi-goals]\nPlan changed. Inspect the evidence.\n\n# Output\n\nKeep this entire requirement.\n\nFinal evidence line.";
	expect(transform(content, { messageType: "user" })).toBe(content);
	display.mirror(content);
	expect(pi.appendEntry).toHaveBeenCalledExactlyOnceWith("pi-goals-notice", { content });
	expect(transform(content, { messageType: "user" })).toBe("");
	expect(transform(content, { messageType: "assistant" })).toBe(content);
	expect(transform("[pi-goals]\nA human quotation", { messageType: "user" })).toBe("[pi-goals]\nA human quotation");

	const entry = { type: "custom", customType: "pi-goals-notice", data: { content } };
	const collapsed = render(entry, { expanded: false }, theme);
	for (const width of [24, 80]) {
		const lines = collapsed.render(width);
		expect(lines).toHaveLength(1);
		expect(visibleWidth(lines[0])).toBeLessThanOrEqual(width);
		expect(lines.join("\n")).not.toContain("Final evidence line");
	}
	const expanded = render(entry, { expanded: true }, theme);
	expect(expanded.render(80)).toEqual(new Markdown(content, 0, 0, getMarkdownTheme()).render(80));
	expect(expanded.render(80).join("\n")).toContain("Final evidence line");

	display.restore({ sessionManager: { getBranch: () => [] } } as unknown as ExtensionContext);
	expect(transform(content, { messageType: "user" })).toBe(content);
	display.restore({ sessionManager: { getBranch: () => [entry] } } as unknown as ExtensionContext);
	expect(transform(content, { messageType: "user" })).toBe("");
	expect(entry.data.content).toBe(content);
});
