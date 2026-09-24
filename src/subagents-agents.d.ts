// pi-subagents publishes source whose internal graph targets another Pi SDK; type only the public call used here.
declare module "pi-subagents/agents" {
	export function registerAgentViaEvents(input: {
		pi: { events: { emit(channel: string, data: unknown): void } };
		name: string;
		definition: Record<string, unknown> & { description: string; systemPrompt: string };
	}): { dispose(): void };
}
