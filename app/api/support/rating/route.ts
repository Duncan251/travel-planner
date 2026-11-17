import { rateConversation } from "@/lib/support-log";

export const runtime = "nodejs";

// Saves a "Did this help?" answer from the Help panel, using the conversation's signed pass.
export async function POST(req: Request) {
  const { conversation, rating } = ((await req.json().catch(() => null)) ?? {}) as { conversation?: unknown; rating?: unknown };
  const saved = await rateConversation(conversation, rating);
  return new Response(null, { status: saved ? 204 : 400 });
}
