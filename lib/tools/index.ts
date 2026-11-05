import type Anthropic from "@anthropic-ai/sdk";
import { getWeather, getWeatherTool, type ToolOutput } from "./weather";

// Every tool Claude can use. To add a tool, add its definition here and its handler below.
export const tools: Anthropic.Tool[] = [getWeatherTool];

const handlers: Record<string, (input: unknown) => Promise<ToolOutput>> = {
  [getWeatherTool.name]: getWeather,
};

// Runs one tool call from Claude and prints it to the terminal.
export async function runTool(name: string, input: unknown): Promise<ToolOutput> {
  const started = Date.now();
  const handler = handlers[name];
  const output: ToolOutput = handler
    ? await handler(input).catch((err) => ({
        content: `The ${name} tool hit an unexpected error: ${err instanceof Error ? err.message : String(err)}`,
        isError: true,
      }))
    : { content: `There is no tool called ${name}.`, isError: true };
  logToolCall(name, input, output, Date.now() - started);
  return output;
}

function logToolCall(name: string, input: unknown, output: ToolOutput, ms: number) {
  const status = output.isError ? "✗ error" : "✓ ok";
  const indent = (text: string) => text.split("\n").map((line) => `│   ${line}`).join("\n");
  console.log(
    [
      "",
      `┌─ 🔧 Tool call: ${name}   ${status}   (${(ms / 1000).toFixed(1)}s)`,
      "│ Input:",
      indent(JSON.stringify(input, null, 2)),
      "│ Result:",
      indent(output.content),
      "└───────────────────────────────",
    ].join("\n"),
  );
}
