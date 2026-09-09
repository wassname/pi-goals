// Pi/OpenAI: Preserve plan wording; omit history and, in the short view, task/evidence details.
export function planViews(plan: string): { short: string; long: string } {
	const long = plan.split(/^#{1,6}\s+(?:Log|Appendix|Appendices|Appendixes|Interview|Learnings|Papercuts)\b.*$/mi)[0].trim();
	const kept: string[] = [];
	let omittedIndent: number | null = null;
	let omittedHeading: number | null = null;
	for (const line of long.split("\n")) {
		const heading = /^(#{1,6})\s+(.+)$/.exec(line);
		if (heading) {
			if (omittedHeading !== null && heading[1].length <= omittedHeading) omittedHeading = null;
			if (/^(?:Tasks?|Task list|Subtasks?|Evidence)\b/i.test(heading[2])) omittedHeading = heading[1].length;
		}
		if (omittedHeading !== null) continue;
		const indent = line.match(/^\s*/)?.[0].length ?? 0;
		if (omittedIndent !== null) {
			if (!line.trim() || indent > omittedIndent) continue;
			omittedIndent = null;
		}
		if (/^\s*[-*]\s+(?:tasks?|subtasks?|evidence):/i.test(line) || /^\s*(?:\d+[.)]|[-*])\s+\[[ x/~-]\]\s+(?!goal:)/i.test(line)) {
			omittedIndent = indent;
			continue;
		}
		kept.push(line);
	}
	return { short: kept.join("\n").trim(), long };
}
