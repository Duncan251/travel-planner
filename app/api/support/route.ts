import Anthropic from "@anthropic-ai/sdk";
import { after } from "next/server";
import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  closeAbandonedConversations,
  conversationEndMarker,
  conversationPassMarker,
  endConversation,
  openConversation,
  recordTicket,
  saveMessages,
  setTopic,
} from "@/lib/support-log";
import { markResolved, markResolvedTool } from "@/lib/tools/resolved";
import type { ConversationEnd } from "@/lib/handoff";
import { loadArticles } from "@/lib/knowledge";
import { createClient, currentUser, supabaseEnv } from "@/lib/supabase/server";
import { runTool } from "@/lib/tools";
import { getMyAccountTool, myAccountHandler } from "@/lib/tools/account";
import { addToTicketHandler, addToTicketTool, escalateToHumanTool, escalationHandler } from "@/lib/tools/escalate";
import { knownTickets, receiptMarker, ticketsNote, verifiedReceiptTickets } from "@/lib/tickets";
import { logUsage, toTotals } from "@/lib/usage";
import { PLANNER_NAME, SUPPORT_NAME, TO_PLANNER_MESSAGE } from "@/lib/handoff";
import { handoffSignal, handoffSummary, logHandoff, transferToPlannerTool } from "@/lib/tools/handoff";

// The support assistant: separate from Katie, with its own prompt (prompts/support.md)
// followed by every help article. Each conversation is logged in support_conversations.
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

  const requestBody = (await req.json().catch(() => null)) as {
    messages?: unknown;
    receipts?: unknown;
    conversation?: unknown;
  } | null;
  const messages = parseMessages(requestBody);
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

  // The logged conversation: continued from the panel's signed pass, or newly started.
  const logged = await openConversation(requestBody?.conversation, user?.id ?? null).catch(() => null);

  // Saving the log, working out the topic and closing abandoned conversations happen after
  // the reply has been sent, so they never slow it down.
  let afterReply: () => Promise<void> = async () => {};
  let replyFinished: () => void = () => {};
  const replyDone = new Promise<void>((resolve) => (replyFinished = resolve));
  after(async () => {
    await replyDone;
    await afterReply().catch((err) => console.error("Support logging failed:", err));
  });

  // Tickets Amber should know about. The panel only keeps her replies' text, not her tool
  // use, so this comes from the database each time: tickets proven by signed receipts to be
  // from this conversation, plus a signed-in person's own recent tickets.
  const conversationTickets = verifiedReceiptTickets(requestBody?.receipts);
  const tickets = await knownTickets(conversationTickets, user?.id ?? null).catch(() => []);
  const issuedTickets: number[] = []; // tickets created during this reply, which get receipts

  // The cached prompt and articles first; the ticket note varies, so it goes after the cache marker.
  const system: Anthropic.TextBlockParam[] = [...(await cachedSystemPrompt()), { type: "text", text: ticketsNote(tickets) }];
  const tools: Anthropic.Tool[] = [getMyAccountTool, transferToPlannerTool, escalateToHumanTool, addToTicketTool, markResolvedTool];
  const handlers = {
    [getMyAccountTool.name]: supabase
      ? myAccountHandler(supabase, user)
      : async () => ({ content: "Not signed in.", isError: false }),
    // Tickets get the verified user (never one Claude names) and the conversation so far.
    [escalateToHumanTool.name]: escalationHandler({
      user,
      conversation: messages,
      visitor,
      conversationTickets,
      onTicket: (n) => {
        issuedTickets.push(n);
        conversationTickets.push(n);
      },
    }),
    [addToTicketTool.name]: addToTicketHandler({ user, conversationTickets, visitor }),
    [markResolvedTool.name]: markResolved,
  };

  const client = new Anthropic();
  const conversation: Anthropic.MessageParam[] = messages.map((m) => ({ role: m.role, content: m.content }));
  let current: { abort(): void } | undefined;

  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (text: string) => controller.enqueue(encoder.encode(text));
      let shown = ""; // what the person sees in this reply, for the log
      const show = (text: string) => {
        shown += text;
        send(text);
      };
      let needsGap = false;
      let handedOff = false;
      let resolved = false;
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
                show("\n\n");
                needsGap = false;
              }
              show(event.delta.text);
            }
          }

          const message: Anthropic.Message = await stream.finalMessage();
          logUsage("💬 Support reply", toTotals(message.usage));
          if (message.stop_reason === "refusal") {
            show("\n\n(Sorry, I can't help with that one.)");
            break;
          }

          const toolCalls = message.content.filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
          if (message.stop_reason !== "tool_use" || toolCalls.length === 0 || round >= MAX_TOOL_ROUNDS) break;

          // Handoff to Katie (signed-in people only, since Katie needs an account): stop here,
          // show the standard handover line, and tell the screen to take them to Katie.
          const transfer = toolCalls.find((c) => c.name === transferToPlannerTool.name);
          if (transfer && user) {
            const summary = handoffSummary(transfer.input) ?? "They'd like help planning a trip.";
            logHandoff(SUPPORT_NAME, PLANNER_NAME, summary, null);
            const wroteText = message.content.some((b) => b.type === "text" && b.text.trim());
            show(`${wroteText || needsGap ? "\n\n" : ""}${TO_PLANNER_MESSAGE}`);
            send(handoffSignal({ to: "planner", summary }));
            handedOff = true;
            break;
          }

          conversation.push({ role: "assistant", content: message.content });
          const results = await Promise.all(
            toolCalls.map(async (call): Promise<Anthropic.ToolResultBlockParam> => {
              if (call.name === transferToPlannerTool.name) {
                return {
                  type: "tool_result",
                  tool_use_id: call.id,
                  content:
                    "Not handed off: they aren't signed in, and Katie needs an account. Explain that they can sign in on the welcome page, then chat with Katie about their trip.",
                };
              }
              const output = await runTool(call.name, call.input, handlers);
              return { type: "tool_result", tool_use_id: call.id, content: output.content, is_error: output.isError };
            }),
          );
          conversation.push({ role: "user", content: results });
          const wroteText = message.content.some((b) => b.type === "text" && b.text.trim());
          if (toolCalls.some((c) => c.name === markResolvedTool.name)) resolved = true;
          // Marking resolved after the closing reply ends the reply (nothing more to say).
          if (wroteText && toolCalls.every((c) => c.name === markResolvedTool.name)) break;
          if (wroteText) needsGap = true;
        }
      } catch (err) {
        console.error("Support route error:", err);
        show(`\n\n⚠️ ${err instanceof Anthropic.APIError ? err.message : "Something went wrong. Please try again."}`);
      } finally {
        // A signed receipt for each ticket created in this reply, for the panel to send back.
        for (const n of issuedTickets) send(receiptMarker(n));

        if (logged) {
          // The panel's pass for a new conversation, and whether to ask "Did this help?".
          if (logged.isNew) send(conversationPassMarker(logged.pass));
          const ticket = issuedTickets.at(-1) ?? null;
          const end: ConversationEnd | null = handedOff
            ? { outcome: "handed_to_katie", askRating: false }
            : resolved
              ? { outcome: ticket || conversationTickets.length ? "escalated" : "resolved", askRating: true }
              : ticket
                ? { outcome: "escalated", askRating: true }
                : null;
          // Record the ticket and any ending before the reply finishes, so a quick
          // "Did this help?" click can never arrive before the log is ready for it.
          const transcript = shown.trim() ? [...messages, { role: "assistant", content: shown.trim() }] : messages;
          if (ticket) await recordTicket(logged.id, ticket).catch(() => {});
          const ended =
            handedOff || resolved
              ? await endConversation(logged.id, handedOff ? "handed_to_katie" : "resolved", transcript).catch(() => null)
              : null;
          if (end) send(conversationEndMarker(end));

          // The slower parts run after the reply has been sent.
          afterReply = async () => {
            if (ended) await setTopic(logged.id, transcript, ended);
            else await saveMessages(logged.id, transcript);
            await closeAbandonedConversations();
          };
        }
        replyFinished();
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
