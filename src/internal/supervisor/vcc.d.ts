/** Typed boundary for pi-vcc 0.5.0's source-only API. Its own source uses older Pi message
 * unions and Intl.Segmenter types; do not typecheck that dependency as pi-goals source. */
declare module "@sting8k/pi-vcc/src/core/summarize.ts" {
	export function compile(input: { messages: unknown[] }): string;
}
declare module "@sting8k/pi-vcc/src/core/normalize.ts" {
	export function normalize(messages: unknown[]): VccBlock[];
	interface VccBlock { type: string; [key: string]: unknown }
}
declare module "@sting8k/pi-vcc/src/extract/files.ts" {
	export function extractFiles(blocks: unknown[]): { modified: Set<string>; created: Set<string> };
}
declare module "@sting8k/pi-vcc/src/extract/commits.ts" {
	export function extractCommits(blocks: unknown[]): Array<{ hash?: string; message: string }>;
}
