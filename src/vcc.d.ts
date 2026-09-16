// VCC 0.6 ships source types for an older Pi Message union. Its pure compiler
// accepts the saved-message shapes exercised by our real-Pi workflow tests.
// Keep this narrow boundary rather than editing vendor code or weakening tsc.
export declare function compile(input: { messages: unknown[] }): string;
