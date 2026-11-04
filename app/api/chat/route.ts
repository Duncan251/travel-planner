import Anthropic from "@anthropic-ai/sdk";
import { readFile } from "node:fs/promises";
import path from "node:path";

// This file runs only on the server. The API key is read here and never sent to the browser.
export const runtime = "nodejs";

const MODEL = "claude-haiku-5-5";
const PROMPT_PATH = path.join(process.cwd(), "prompts", "planner.md");

export async function POST(req: Request) {
  if (!process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY.startsWith("your-")) {
    return new Response("ANTHROPIC_API_KEY is not set. Add your key to .env.local and restart the server.", {
      status: 500,
    });
  }

  const { messages } = (await req.json()) as { messages: Anthropic.MessageParam[] };

  // Re-read on every request so edits to prompts/planner.md apply without a restart.
  const system = (await readFile(PROMPT_PATH, "utf8")).trim();

  const client = new Anthropic(); // picks up ANTHROPIC_API_KEY from the environment

  const stream = client.messages.stream({
    model: MODEL,
    max_tokens: 16000,
    output_config: { effort: "low" }, // quick, conversational replies
    system,
    messages,
  });

  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        for await (const event of stream) {
          if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
            controller.enqueue(encoder.encode(event.delta.text));
          }
        }
        const final = await stream.finalMessage();
        if (final.stop_reason === "refusal") {
          controller.enqueue(encoder.encode("\n\n(Claude declined to answer this request.)"));
        }
      } catch (err) {
        const message = err instanceof Anthropic.APIError ? err.message : "Unexpected error talking to Claude.";
        controller.enqueue(encoder.encode(`\n\n⚠️ ${message}`));
      } finally {
        controller.close();
      }
    },
    cancel() {
      stream.abort();
    },
  });

  return new Response(body, {
    headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-cache" },
  });
}
