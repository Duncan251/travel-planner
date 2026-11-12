// What every tool hands back to the chat route: the text Claude reads, and whether it's an error.
export type ToolOutput = { content: string; isError: boolean };
