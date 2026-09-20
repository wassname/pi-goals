// Pi/OpenAI: Record task/evidence activity, but wake only for requirements or goal status.
import { foldPlan, GOAL_LINE, planRequirements } from "./plan.js";

export function planViews(plan: string): { notify: string; activity: string } {
	const identity = /^[ \t]*[-*]\s*(?:active worker|worker session|worker intercom session):/i;
	const activity = foldPlan(plan).split("\n").filter(line => !identity.test(line)).join("\n").trim();
	const status = activity.split("\n").filter(line => GOAL_LINE.test(line));
	const preferences = activity.split("\n").filter(line => /^\s*[-*]\s*preferred worker model:/i.test(line));
	return { activity, notify: [planRequirements(plan), ...status, ...preferences].filter(Boolean).join("\n") };
}
