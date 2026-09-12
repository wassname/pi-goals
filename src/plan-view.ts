// Pi/OpenAI: Review task/evidence changes, but omit history and worker identity bookkeeping.
import { foldPlan } from "./plan.js";

export function planViews(plan: string): { notify: string } {
	const identity = /^[ \t]*[-*]\s*(?:active worker|worker session|worker intercom session):/i;
	return { notify: foldPlan(plan).split("\n").filter(line => !identity.test(line)).join("\n").trim() };
}
