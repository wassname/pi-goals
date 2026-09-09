// VCC 0.5.0 ships source only; describe its compiler boundary without typechecking upstream internals.
declare module "@sting8k/pi-vcc/src/core/summarize" {
	import type { Message } from "@earendil-works/pi-ai";
	export interface CompileInput {
		messages: Message[];
		previousSummary?: string;
		fileOps?: { readFiles?: string[]; modifiedFiles?: string[]; createdFiles?: string[] };
	}
	export function compile(input: CompileInput): string;
}
