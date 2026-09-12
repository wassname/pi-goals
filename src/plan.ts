// Pi/OpenAI: Log, at any heading level, is the single boundary between current work and history.
export const GOAL_LINE = /^\s*(?:\d+\.|[-*])\s*\[([ xX/-])\]\s*goal:\s*(.*)$/i;
export const FOLD_LINE = /^#{1,6}[ \t]+Log[ \t]*\r?$/im;
const identity = /^[ \t]*[-*]\s*(?:active worker|worker session|worker intercom session|preferred worker model):/i;

export function foldPlan(plan: string): string {
	const match = FOLD_LINE.exec(plan);
	return (match ? plan.slice(0, match.index) : plan).trimEnd();
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
