import Anthropic from "@anthropic-ai/sdk";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { loadArticles } from "@/lib/knowledge";
import { createClient, currentUser, supabaseEnv } from "@/lib/supabase/server";
import { runTool } from "@/lib/tools";
import { getMyAccountTool, myAccountHandler } from "@/lib/tools/account";
import { logUsage, toTotals } from "@/lib/usage";

// The support assistant: separate from Katie, with its own prompt (prompts/support.md)
// followed by every help article. Conversations aren't stored.
export const runtime = "nodejs";

const MODEL = "claude-haiku-5-5"; // same model as Katie
const PROMPT_PATH = path.join(process.cwd(), "prompts", "support.md");
const MAX_TOOL_ROUNDS = 3;
const MAX_HISTORY = 20; // messages from the panel sent to Claude
const MAX_MESSAGE_LENGTH = 4000;
// Support has its own daily cap, separate from Katie's message limit (the help articles
// promise support messages don't count toward that). Kept in server memory, so it's
// best-effort: it resets when the server restarts.
const SUPPORT_DAILY_LIMIT = 30;

type PanelMessage = { role: "user" | "assistant"; content: string };

export async function POST(req: Request) {
  if (!process.env.ANTHROPIC_API_KEY) {
    return new Response("The support assistant isn't set up yet.", { status: 500 });
  }

  const messages = parseMessages(await req.json().catch(() => null));
  if (!messages) return new Response("That message couldn't be read. Please try again.", { status: 400 });

  // Who's asking, if anyone. Signed-out visitors can still get help.
  const supabase = supabaseEnv() ? await createClient() : null;
  const user = supabase ? await currentUser(supabase) : null;

  const visitor = user ? `user:${user.id}` : `ip:${req.headers.get("x-forwarded-for")?.split(",")[0].trim() ?? "unknown"}`;
  if (!takeSupportMessage(visitor)) {
    return new Response(
      `You've reached today's limit of ${SUPPORT_DAILY_LIMIT} help messages. It resets at midnight UTC.`,
      { status: 429 },
    );
  }

  const system = await cachedSystemPrompt();
  const tools: Anthropic.Tool[] = [getMyAccountTool];
  const handlers = {
    [getMyAccountTool.name]: supabase
      ? myAccountHandler(supabase, user)
      : async () => ({ content: "Not signed in.", isError: false }),
  };

  const client = new Anthropic();
  const conversation: Anthropic.MessageParam[] = messages.map((m) => ({ role: m.role, content: m.content }));
  let current: { abort(): void } | undefined;

  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (text: string) => controller.enqueue(encoder.encode(text));
      let needsGap = false;
      try {
        for (let round = 0; ; round++) {
          const stream = client.messages.stream({
            model: MODEL,
            max_tokens: 4000,
            output_config: { effort: "low" }, // quick help-desk answers
            system,
            tools,
            messages: conversation,
          });
          current = stream;

          for await (const event of stream) {
            if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
              if (needsGap) {
                send("\n\n");
                needsGap = false;
              }
              send(event.delta.text);
            }
          }

          const message: Anthropic.Message = await stream.finalMessage();
          logUsage("💬 Support reply", toTotals(message.usage));
          if (message.stop_reason === "refusal") {
            send("\n\n(Sorry, I can't help with that one.)");
            break;
          }

          const toolCalls = message.content.filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
          if (message.stop_reason !== "tool_use" || toolCalls.length === 0 || round >= MAX_TOOL_ROUNDS) break;

          conversation.push({ role: "assistant", content: message.content });
          const results = await Promise.all(
            toolCalls.map(async (call): Promise<Anthropic.ToolResultBlockParam> => {
              const output = await runTool(call.name, call.input, handlers);
              return { type: "tool_result", tool_use_id: call.id, content: output.content, is_error: output.isError };
            }),
          );
          conversation.push({ role: "user", content: results });
          if (message.content.some((b) => b.type === "text" && b.text.trim())) needsGap = true;
        }
      } catch (err) {
        console.error("Support route error:", err);
        send(`\n\n⚠️ ${err instanceof Anthropic.APIError ? err.message : "Something went wrong. Please try again."}`);
      } finally {
        controller.close();
      }
    },
    cancel() {
      current?.abort();
    },
  });

  return new Response(body, { headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-cache" } });
}

// The support prompt followed by every help article, as one block marked for caching.
// It must be byte-for-byte the same on every request for the cache to match, so nothing
// that varies (dates, who's signed in) goes in here.
async function cachedSystemPrompt(): Promise<Anthropic.TextBlockParam[]> {
  const [prompt, articles] = await Promise.all([readFile(PROMPT_PATH, "utf8"), loadArticles()]);
  const library = articles
    .map((a) => `## Article: ${a.title}\nCategory: ${a.category}\n\n${a.body}`)
    .join("\n\n---\n\n");
  return [{ type: "text", text: `${prompt.trim()}\n\n${library}`, cache_control: { type: "ephemeral" } }];
}

// Checks the panel's conversation: alternating turns, starting and ending with the person.
function parseMessages(body: unknown): PanelMessage[] | null {
  const list = (body as { messages?: unknown } | null)?.messages;
  if (!Array.isArray(list) || list.length === 0) return null;
  const recent = list.slice(-MAX_HISTORY);
  while (recent.length && (recent[0] as PanelMessage)?.role !== "user") recent.shift();
  const ok = recent.every(
    (m, i) =>
      m &&
      m.role === (i % 2 === 0 ? "user" : "assistant") &&
      typeof m.content === "string" &&
      m.content.trim() &&
      m.content.length <= MAX_MESSAGE_LENGTH,
  );
  if (!ok || recent.length % 2 === 0) return null;
  return recent.map((m) => ({ role: m.role, content: m.content.trim() }));
}

// Daily support cap per signed-in user or (for signed-out visitors) per internet address.
const usage: { day: string; counts: Map<string, number> } = ((globalThis as { __supportUsage?: { day: string; counts: Map<string, number> } })
  .__supportUsage ??= { day: "", counts: new Map() });

function takeSupportMessage(visitor: string): boolean {
  const today = new Date().toISOString().slice(0, 10);
  if (usage.day !== today) {
    usage.day = today;
    usage.counts.clear();
  }
  const used = usage.counts.get(visitor) ?? 0;
  if (used >= SUPPORT_DAILY_LIMIT) return false;
  usage.counts.set(visitor, used + 1);
  return true;
}
