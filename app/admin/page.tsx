import type { Metadata } from "next";
import { requireAdmin } from "@/lib/admin";
import { createAdminClient } from "@/lib/supabase/admin";
import { SUPPORT_TOPICS } from "@/lib/supabase/database.types";
import { resolveTicket } from "./actions";

export const metadata: Metadata = { title: "Admin · Travel Planner", robots: { index: false, follow: false } };
export const dynamic = "force-dynamic"; // always fresh, never cached

const DEFAULT_DAYS = 30;
const OUTCOMES = [
  { key: "resolved", label: "Resolved" },
  { key: "handed_to_katie", label: "Handed to Katie" },
  { key: "escalated", label: "Escalated" },
  { key: "abandoned", label: "Abandoned" },
  { key: null, label: "Still open" },
] as const;

type Message = { role: string; content: string };

// Private admin page: only the account in ADMIN_EMAIL can open it; everyone else gets 404.
export default async function AdminPage({ searchParams }: { searchParams: Promise<{ from?: string; to?: string }> }) {
  await requireAdmin(); // before anything else is loaded

  const range = dateRange(await searchParams);
  const admin = createAdminClient();
  if (!admin) throw new Error("SUPABASE_SERVICE_ROLE_KEY is not set");

  const [conversations, openTickets, thumbsDown] = await Promise.all([
    admin
      .from("support_conversations")
      .select("outcome, topic, rating")
      .gte("started_at", range.startIso)
      .lt("started_at", range.endIso)
      .limit(10000),
    admin
      .from("tickets")
      .select("ticket_number, title, email, summary, already_tried, reason, updates, conversation, created_at")
      .eq("status", "open")
      .order("created_at", { ascending: false })
      .limit(100),
    admin
      .from("support_conversations")
      .select("id, started_at, topic, outcome, ticket_number, messages")
      .eq("rating", "down")
      .gte("started_at", range.startIso)
      .lt("started_at", range.endIso)
      .order("rated_at", { ascending: false })
      .limit(10),
  ]);

  const rows = conversations.data ?? [];
  const total = rows.length;
  const percent = (n: number, of: number) => (of ? `${Math.round((n / of) * 100)}%` : "–");
  const ups = rows.filter((r) => r.rating === "up").length;
  const downs = rows.filter((r) => r.rating === "down").length;
  const topics = [...SUPPORT_TOPICS, null]
    .map((topic) => ({ topic, count: rows.filter((r) => r.topic === topic).length }))
    .filter((t) => t.count > 0)
    .sort((a, b) => b.count - a.count);

  return (
    <main className="doc">
      <article className="doc-card admin">
        <h1>Admin</h1>

        <form method="get" className="admin-range">
          <label>
            From <input type="date" name="from" defaultValue={range.from} />
          </label>
          <label>
            To <input type="date" name="to" defaultValue={range.to} />
          </label>
          <button type="submit">Apply</button>
          <a href="/admin" className="small">
            Last {DEFAULT_DAYS} days
          </a>
        </form>

        {(conversations.error || openTickets.error || thumbsDown.error) && (
          <p className="access-error">
            Some data couldn&apos;t be loaded: {conversations.error?.message ?? openTickets.error?.message ?? thumbsDown.error?.message}
          </p>
        )}

        <section className="doc-section">
          <h2>Support conversations</h2>
          <p className="admin-big">{total}</p>
          <p className="small">
            started {range.from} to {range.to}
          </p>
          <table className="admin-table">
            <thead>
              <tr>
                <th>Outcome</th>
                <th>Count</th>
                <th>%</th>
              </tr>
            </thead>
            <tbody>
              {OUTCOMES.map(({ key, label }) => {
                const count = rows.filter((r) => r.outcome === key).length;
                if (key === null && count === 0) return null;
                return (
                  <tr key={label}>
                    <td>{label}</td>
                    <td>{count}</td>
                    <td>{percent(count, total)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </section>

        <section className="doc-section">
          <h2>Did this help?</h2>
          <p className="admin-big">{percent(ups, ups + downs)}</p>
          <p className="small">
            thumbs up · {ups} 👍 and {downs} 👎 from {ups + downs} rated conversation{ups + downs === 1 ? "" : "s"}
          </p>
        </section>

        <section className="doc-section">
          <h2>Top topics</h2>
          {topics.length === 0 ? (
            <p className="small">No conversations in this range.</p>
          ) : (
            <table className="admin-table">
              <thead>
                <tr>
                  <th>Topic</th>
                  <th>Count</th>
                  <th>%</th>
                </tr>
              </thead>
              <tbody>
                {topics.map(({ topic, count }) => (
                  <tr key={topic ?? "none"}>
                    <td>{topic ?? "Not classified yet"}</td>
                    <td>{count}</td>
                    <td>{percent(count, total)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>

        <section className="doc-section">
          <h2>Open tickets ({openTickets.data?.length ?? 0})</h2>
          <p className="small">All open tickets, newest first, whatever the date range.</p>
          {!openTickets.data?.length ? (
            <p className="small">No open tickets. 🎉</p>
          ) : (
            openTickets.data.map((t) => (
              <details key={t.ticket_number} className="admin-item">
                <summary>
                  <strong>KT-{t.ticket_number}</strong> · {t.title}{" "}
                  <span className="small">
                    · {shortDate(t.created_at)} · {t.email}
                  </span>
                </summary>
                <div className="admin-detail">
                  <p>
                    <strong>Summary:</strong> {t.summary}
                  </p>
                  {t.already_tried && (
                    <p>
                      <strong>Already tried:</strong> {t.already_tried}
                    </p>
                  )}
                  {t.reason && (
                    <p>
                      <strong>Reason:</strong> {t.reason}
                    </p>
                  )}
                  {Array.isArray(t.updates) && t.updates.length > 0 && (
                    <>
                      <p>
                        <strong>Updates:</strong>
                      </p>
                      <ul>
                        {t.updates.map((u, i) => (
                          <li key={i}>
                            <span className="small">{shortDate(u.at)}:</span> {u.text}
                          </li>
                        ))}
                      </ul>
                    </>
                  )}
                  <Transcript messages={t.conversation} />
                  <form action={resolveTicket}>
                    <input type="hidden" name="ticket" value={t.ticket_number} />
                    <button type="submit">Mark KT-{t.ticket_number} resolved</button>
                  </form>
                </div>
              </details>
            ))
          )}
        </section>

        <section className="doc-section">
          <h2>Recent 👎 conversations</h2>
          {!thumbsDown.data?.length ? (
            <p className="small">None in this range.</p>
          ) : (
            thumbsDown.data.map((c) => (
              <details key={c.id} className="admin-item">
                <summary>
                  {shortDate(c.started_at)} · {c.topic ?? "not classified"} · {outcomeLabel(c.outcome)}
                  {c.ticket_number ? ` · KT-${c.ticket_number}` : ""}
                </summary>
                <div className="admin-detail">
                  <Transcript messages={c.messages} />
                </div>
              </details>
            ))
          )}
        </section>
      </article>
    </main>
  );
}

function Transcript({ messages }: { messages: Message[] }) {
  if (!messages?.length) return <p className="small">No conversation saved.</p>;
  return (
    <div className="admin-transcript">
      {messages.map((m, i) => (
        <p key={i}>
          <strong>{m.role === "user" ? "Person" : "Amber"}:</strong> {m.content}
        </p>
      ))}
    </div>
  );
}

// The chosen date range (inclusive), defaulting to the last 30 days, in UTC.
function dateRange(params: { from?: string; to?: string }) {
  const valid = (s?: string) => (s && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s)) ? s : null);
  const today = new Date().toISOString().slice(0, 10);
  const defaultFrom = new Date(Date.now() - (DEFAULT_DAYS - 1) * 86_400_000).toISOString().slice(0, 10);
  let from = valid(params.from) ?? defaultFrom;
  let to = valid(params.to) ?? today;
  if (from > to) [from, to] = [to, from];
  const endIso = new Date(Date.parse(`${to}T00:00:00Z`) + 86_400_000).toISOString();
  return { from, to, startIso: `${from}T00:00:00Z`, endIso };
}

function shortDate(iso: string): string {
  return new Date(iso).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "UTC" }) + " UTC";
}

function outcomeLabel(outcome: string | null): string {
  return OUTCOMES.find((o) => o.key === outcome)?.label.toLowerCase() ?? "still open";
}
