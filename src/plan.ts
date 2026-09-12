// Pi/OpenAI: Log, at any heading level, is the single boundary between current work and history.
export const GOAL_LINE = /^\s*(?:\d+\.|[-*])\s*\[([ xX/-])\]\s*goal:\s*(.*)$/i;
export const FOLD_LINE = /^#{1,6}[ \t]+Log[ \t]*\r?$/im;
const identity = /^[ \t]*[-*]\s*(?:active worker|worker session|worker intercom session|preferred worker model):/i;

export function foldPlan(plan: string): string {
	const match = FOLD_LINE.exec(plan);
	return (match ? plan.slice(0, match.index) : plan).trimEnd();
}

const heading = /^(#{1,6})[ \t]+(.+?)[ \t]*$/;

function namedSection(lines: string[], name: string): string[] {
	const start = lines.findIndex((line) => {
		const match = heading.exec(line);
		return match?.[2].toLowerCase() === name.toLowerCase();
	});
	if (start === -1) return [];
	const level = heading.exec(lines[start])![1].length;
	const end = lines.findIndex((line, index) => index > start && (heading.exec(line)?.[1].length ?? Infinity) <= level);
	return lines.slice(start, end === -1 ? undefined : end).join("\n").trimEnd().split("\n");
}

// Context tiers retain direct requirements while keeping normal reminders small. -- PI/gpt-5.6-terra
export function planContextView(plan: string, tier: "short" | "medium" | "full"): string {
	if (tier === "full") return plan.trimEnd();
	const workingSet = foldPlan(plan);
	const lines = workingSet.split("\n");
	const titleIndex = lines.findIndex(line => /^#(?!#)[ \t]+/.test(line));
	const title = titleIndex === -1 ? [] : [lines[titleIndex]];
	const introStart = titleIndex === -1 ? 0 : titleIndex + 1;
	let firstContent = introStart;
	while (firstContent < lines.length && !lines[firstContent].trim()) firstContent++;
	const intro: string[] = [];
	if (firstContent < lines.length && !heading.test(lines[firstContent])) {
		for (let index = firstContent; index < lines.length && lines[index].trim(); index++) intro.push(lines[index]);
	}
	const result = namedSection(lines, "User-visible result");
	const short = [...title, ...(intro.length ? ["", ...intro] : []), ...(result.length ? ["", ...result] : [])].join("\n").trimEnd();
	if (tier === "short") return short;
	const userVoice = namedSection(lines, "User voice");
	const goalsHeading = namedSection(lines, "Goals")[0];
	const goalLines = lines.filter(line => GOAL_LINE.test(line));
	return [short, ...(userVoice.length ? ["", ...userVoice] : []), ...(goalsHeading && goalLines.length ? ["", goalsHeading, ...goalLines] : [])].join("\n").trimEnd();
}

// Pi/OpenAI: Approval covers shared requirements and this goal, not checkbox/task/evidence maintenance.
export function goalAcceptanceSignature(plan: string, goal: string): string | undefined {
	const lines = foldPlan(plan).split("\n");
	const goals = lines.flatMap((line, index) => {
		const match = GOAL_LINE.exec(line);
		return match ? [{ index, subject: match[2].trim().toLowerCase() }] : [];
	});
	const matches = goals.filter(item => item.subject === goal.trim().toLowerCase());
	if (matches.length !== 1) return undefined;
	const selected = matches[0];
	const end = goals.find(item => item.index > selected.index)?.index ?? lines.length;
	const content = [...lines.slice(0, goals[0].index), `goal: ${selected.subject}`, ...lines.slice(selected.index + 1, end)];
	const kept: string[] = [];
	let omittedIndent: number | undefined;
	let omittedHeading: number | undefined;
	for (const line of content) {
		if (identity.test(line)) continue;
		const heading = /^(#{1,6})\s+(.+)$/.exec(line);
		if (heading) {
			if (omittedHeading !== undefined && heading[1].length <= omittedHeading) omittedHeading = undefined;
			if (/^(?:Tasks?|Task list|Subtasks?|Evidence)\b/i.test(heading[2])) omittedHeading = heading[1].length;
		}
		if (omittedHeading !== undefined) continue;
		const indent = line.length - line.trimStart().length;
		if (omittedIndent !== undefined) {
			if (!line.trim() || indent > omittedIndent) continue;
			omittedIndent = undefined;
		}
		if (/^\s*[-*]\s+(?:tasks?|subtasks?|evidence):/i.test(line) || /^\s*(?:\d+[.)]|[-*])\s+\[[ xX/~-]\]/.test(line)) {
			omittedIndent = indent;
			continue;
		}
		if (line.trim()) kept.push(line.trim());
	}
	return kept.join("\n");
}
