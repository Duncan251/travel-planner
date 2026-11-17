import { closeAbandonedConversations } from "@/lib/support-log";

export const runtime = "nodejs";

// Daily backstop (scheduled in vercel.json): closes support conversations with no message for
// 30 minutes as "abandoned", in case nobody has used Help since. Vercel sends CRON_SECRET with
// the request; anyone without it is refused.
export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers.get("authorization") !== `Bearer ${secret}`) {
    return new Response("Not allowed.", { status: 401 });
  }
  const closed = await closeAbandonedConversations(200);
  console.log(`🧹 Support sweep: closed ${closed} abandoned conversation(s)`);
  return Response.json({ closed });
}
