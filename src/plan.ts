// Shared plan syntax: only the section above the Log contains current goals.
export const GOAL_LINE = /^\s*(?:\d+\.|[-*])\s*\[([ xX/-])\]\s*goal:\s*(.*)$/i;
export const FOLD_LINE = /^##\s+Log\s*$/im;

export function foldPlan(plan: string): string {
	const match = FOLD_LINE.exec(plan);
	return (match ? plan.slice(0, match.index) : plan).trimEnd();
}
