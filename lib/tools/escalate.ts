import "server-only"; // saves with the administrator key and sends email
import type Anthropic from "@anthropic-ai/sdk";
import { escapeHtml, sendEmail } from "../email";
import { createAdminClient } from "../supabase/admin";
import type { ToolOutput } from "./types";

// Amber's escalate_to_human tool: saves a support ticket and emails the team.
// Settings: SUPPORT_INBOX_EMAIL (where tickets are emailed), SUPPORT_FALLBACK_EMAIL (the
// address people are given if something fails), RESEND_API_KEY and RESEND_FROM.

const REPLY_TIME = "within two working days";
const DAILY_TICKET_LIMIT = 3; // per person (or per internet address if signed out)
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export const escalateToHumanTool: Anthropic.Tool = {
  name: "escalate_to_human",
  description: `Pass a problem to a person on the Katie Travel team by creating a support ticket. The team is emailed and replies to the person by email.

Use it when:
- they ask to speak to a person, or to pass a message, complaint or suggestion to the team
- something is broken or wrong in a way the help articles can't fix (for example a missing trip, an error that keeps happening, a sign-in email that never arrives after the steps in "I didn't receive my sign-in email")
- they need something only the team can do

Don't use it for questions the help articles answer: answer those yourself. Before escalating a problem, try the relevant help article's steps with them, unless they just want to reach a person.

If they aren't signed in, ask for their email address first and include it; the tool won't work without one. If they are signed in, their account email is used automatically.

Only one ticket per problem. If a ticket already exists for this problem (see "Tickets already raised"), use add_to_ticket for any new details instead. Set new_problem to true only when they raise a genuinely different problem.

The result gives you a ticket number and when to expect a reply: pass both on. If it says saving or emailing failed, tell them honestly and give them the fallback email address it provides. Never say a ticket was created unless the result says so.`,
  eager_input_streaming: true,
  input_schema: {
    type: "object",
    properties: {
      title: { type: "string", description: 'A short title, e.g. "Sign-in email never arrives".' },
      summary: { type: "string", description: "What the problem is, in a few sentences, with any details they gave." },
      already_tried: { type: "string", description: "What you or they have already tried, and what happened." },
      reason: { type: "string", description: "Why this needs a person, e.g. \"They asked to speak to someone\" or \"The help steps didn't work\"." },
      email: { type: "string", description: "Their email address. Only needed if they aren't signed in." },
      new_problem: {
        type: "boolean",
        description: "True only if a ticket already exists in this conversation and this is a different problem.",
      },
    },
    required: ["title", "summary", "already_tried", "reason"],
    additionalProperties: false,
  },
};

type EscalationContext = {
  user: { id: string; email: string | null } | null; // verified by the server, never by Claude
  conversation: { role: string; content: string }[];
  visitor: string; // for the daily ticket cap
  conversationTickets: number[]; // tickets created earlier in this conversation (signed receipts)
  onTicket: (ticketNumber: number) => void; // called when a ticket is created, to issue a receipt
};

const ticketsToday: { day: string; counts: Map<string, number> } = ((globalThis as { __ticketsToday?: { day: string; counts: Map<string, number> } })
  .__ticketsToday ??= { day: "", counts: new Map() });

export function escalationHandler(ctx: EscalationContext) {
  return async (input: unknown): Promise<ToolOutput> => {
    const fallback = process.env.SUPPORT_FALLBACK_EMAIL;
    const fallbackLine = fallback
      ? `Give them this address to email instead: ${fallback}`
      : "Ask them to try again later.";

    const { title, summary, already_tried, reason, email, new_problem } = (input ?? {}) as Record<string, unknown>;
    const text = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");
    const t = { title: text(title, 120), summary: text(summary, 2000), tried: text(already_tried, 2000), reason: text(reason, 1000) };
    if (!t.title || !t.summary) return { content: "Not escalated: a title and summary are needed.", isError: true };

    // One ticket per problem: a ticket from earlier in this conversation gets updates instead.
    if (ctx.conversationTickets.length && new_problem !== true) {
      const existing = ctx.conversationTickets.map((n) => `KT-${n}`).join(", ");
      return {
        content: `Not escalated: ${existing} already exists for this conversation and is with the team. If this is more detail about the same problem, use add_to_ticket with that number. Only if it's a genuinely different problem, call this again with new_problem set to true.`,
        isError: true,
      };
    }

    // Who to reply to: the account email for signed-in people; otherwise the address they gave.
    const replyTo = ctx.user?.email ?? text(email, 320);
    if (!replyTo || !EMAIL_PATTERN.test(replyTo)) {
      return {
        content: "Not escalated: they aren't signed in, so ask for their email address first, then call this again with it.",
        isError: true,
      };
    }

    if (!takeTicket(ctx.visitor)) {
      return {
        content: `Not escalated: they've already raised ${DAILY_TICKET_LIMIT} tickets today. Let them know the team has those and will reply ${REPLY_TIME}. ${fallbackLine}`,
        isError: true,
      };
    }

    // 1. Save the ticket.
    let ticketNumber: number | null = null;
    let saveError: string | null = null;
    const admin = createAdminClient();
    if (!admin) {
      saveError = "the server's database key isn't set";
    } else {
      const { data, error } = await admin
        .from("tickets")
        .insert({
          user_id: ctx.user?.id ?? null,
          email: replyTo,
          title: t.title,
          summary: t.summary,
          already_tried: t.tried || null,
          reason: t.reason || null,
          conversation: ctx.conversation,
        })
        .select("ticket_number")
        .single();
      if (error || !data) saveError = error?.message ?? "no ticket was returned";
      else ticketNumber = data.ticket_number;
    }
    const ticket = ticketNumber ? `KT-${ticketNumber}` : null;
    if (ticketNumber) ctx.onTicket(ticketNumber);

    // 2. Email the team (even if saving failed, so the problem still reaches someone).
    const inbox = process.env.SUPPORT_INBOX_EMAIL;
    const emailError = inbox ? await sendEmail(ticketEmail(inbox, ticket, replyTo, t, ctx)) : "SUPPORT_INBOX_EMAIL is not set";

    console.log(
      `🎫 Escalation: ${ticket ?? "NOT SAVED"} · ${t.title}\n   From: ${ctx.user ? "signed-in user" : "signed-out visitor"} · saved: ${saveError ? `no (${saveError})` : "yes"} · emailed: ${emailError ? `no (${emailError})` : "yes"}\n   Summary: ${t.summary}`,
    );

    // 3. Report back honestly.
    if (ticket && !emailError) {
      return {
        content: `Ticket ${ticket} created and the team has been emailed. Tell them their ticket number is ${ticket} and that the team aims to reply by email to ${replyTo} ${REPLY_TIME}.`,
        isError: false,
      };
    }
    if (ticket) {
      return {
        content: `Ticket ${ticket} was saved, but emailing the team failed, so they may not see it straight away. Tell them honestly: give them the ticket number ${ticket}, and explain the reply could take longer than usual. ${fallbackLine} (quoting ${ticket}).`,
        isError: true,
      };
    }
    if (!emailError) {
      return {
        content: `The ticket couldn't be saved, so there's no ticket number, but the team was emailed the details. Tell them honestly that the team has their message and aims to reply to ${replyTo} ${REPLY_TIME}. If they don't hear back: ${fallbackLine}`,
        isError: true,
      };
    }
    return {
      content: `Not escalated: saving the ticket and emailing the team both failed. Apologise and tell them honestly that you couldn't pass it on. ${fallbackLine}`,
      isError: true,
    };
  };
}

function takeTicket(visitor: string): boolean {
  const today = new Date().toISOString().slice(0, 10);
  if (ticketsToday.day !== today) {
    ticketsToday.day = today;
    ticketsToday.counts.clear();
  }
  const used = ticketsToday.counts.get(visitor) ?? 0;
  if (used >= DAILY_TICKET_LIMIT) return false;
  ticketsToday.counts.set(visitor, used + 1);
  return true;
}

// The email the team receives. Replying goes straight to the person.
function ticketEmail(
  to: string,
  ticket: string | null,
  replyTo: string,
  t: { title: string; summary: string; tried: string; reason: string },
  ctx: EscalationContext,
) {
  const link = ticketsLink();
  const heading = ticket ? `Ticket ${ticket}` : "Ticket NOT SAVED (details below)";
  const who = `${replyTo} (${ctx.user ? "signed in" : "not signed in"})`;
  const transcript = ctx.conversation.map((m) => `${m.role === "user" ? "Person" : "Amber"}: ${m.content}`).join("\n\n");

  const text = [
    `${heading}: ${t.title}`,
    "",
    `From: ${who}`,
    `Reason: ${t.reason || "(not given)"}`,
    "",
    `Summary:\n${t.summary}`,
    "",
    `Already tried:\n${t.tried || "(nothing noted)"}`,
    "",
    link ? `View it in Supabase (Table Editor > tickets, ticket_number ${ticket?.slice(3) ?? "n/a"}):\n${link}` : "",
    "",
    "Reply to this email to answer them directly.",
    "",
    "--- Conversation ---",
    transcript,
  ].join("\n");

  const html = `
    <h2>${escapeHtml(heading)}: ${escapeHtml(t.title)}</h2>
    <p><strong>From:</strong> ${escapeHtml(who)}<br><strong>Reason:</strong> ${escapeHtml(t.reason || "(not given)")}</p>
    <h3>Summary</h3><p>${escapeHtml(t.summary).replace(/\n/g, "<br>")}</p>
    <h3>Already tried</h3><p>${escapeHtml(t.tried || "(nothing noted)").replace(/\n/g, "<br>")}</p>
    ${link ? `<p><a href="${link}">View it in Supabase</a> (Table Editor › tickets, ticket_number ${escapeHtml(ticket?.slice(3) ?? "n/a")})</p>` : ""}
    <p>Reply to this email to answer them directly.</p>
    <h3>Conversation</h3>
    ${ctx.conversation.map((m) => `<p><strong>${m.role === "user" ? "Person" : "Amber"}:</strong> ${escapeHtml(m.content).replace(/\n/g, "<br>")}</p>`).join("")}
  `;

  return { to, subject: `[Katie Travel] ${ticket ?? "Unsaved ticket"}: ${t.title}`, text, html, replyTo };
}

// The Supabase table editor, where tickets can be viewed and resolved.
function ticketsLink(): string | null {
  const ref = process.env.SUPABASE_URL ? new URL(process.env.SUPABASE_URL).hostname.split(".")[0] : null;
  return ref ? `https://supabase.com/dashboard/project/${ref}/editor` : null;
}

// ---------------------------------------------------------------------------
// add_to_ticket: adds new details to an existing ticket instead of opening another.
// ---------------------------------------------------------------------------

const DAILY_UPDATE_LIMIT = 10; // per person (or per internet address if signed out)

export const addToTicketTool: Anthropic.Tool = {
  name: "add_to_ticket",
  description: `Add new details to a support ticket that already exists, and email the team the update. Use it whenever the person gives more information about a problem that already has a ticket (see "Tickets already raised"), instead of creating another ticket.

You can only add to tickets in that list. Afterwards, tell them the details were added to their ticket (give the number). If the result says saving or emailing failed, tell them honestly and give them the fallback email address it provides.`,
  eager_input_streaming: true,
  input_schema: {
    type: "object",
    properties: {
      ticket_number: { type: "string", description: 'The ticket to add to, e.g. "KT-1002".' },
      details: { type: "string", description: "The new information, written for the team, with anything they'll need." },
    },
    required: ["ticket_number", "details"],
    additionalProperties: false,
  },
};

type TicketUpdateContext = {
  user: { id: string; email: string | null } | null; // verified by the server
  conversationTickets: number[]; // tickets proven (by signed receipt) to come from this conversation
  visitor: string;
};

const updatesToday: { day: string; counts: Map<string, number> } = ((globalThis as { __ticketUpdatesToday?: { day: string; counts: Map<string, number> } })
  .__ticketUpdatesToday ??= { day: "", counts: new Map() });

export function addToTicketHandler(ctx: TicketUpdateContext) {
  return async (input: unknown): Promise<ToolOutput> => {
    const fallback = process.env.SUPPORT_FALLBACK_EMAIL;
    const fallbackLine = fallback ? `Give them this address to email instead: ${fallback}` : "Ask them to try again later.";

    const { ticket_number, details } = (input ?? {}) as Record<string, unknown>;
    const number = Number(String(ticket_number ?? "").replace(/\D/g, ""));
    const text = typeof details === "string" ? details.trim().slice(0, 2000) : "";
    if (!number || !text) return { content: "Not added: a ticket number and the new details are needed.", isError: true };

    const admin = createAdminClient();
    if (!admin) return { content: `Not added: the ticket couldn't be reached. ${fallbackLine} (quoting KT-${number}).`, isError: true };

    const { data: ticket, error: loadError } = await admin
      .from("tickets")
      .select("id, ticket_number, title, email, user_id, updates")
      .eq("ticket_number", number)
      .maybeSingle();
    if (loadError) {
      return { content: `Not added: the ticket couldn't be loaded. ${fallbackLine} (quoting KT-${number}).`, isError: true };
    }

    // Only tickets from this conversation, or the signed-in person's own tickets.
    const allowed = ticket && (ctx.conversationTickets.includes(number) || (ctx.user && ticket.user_id === ctx.user.id));
    if (!ticket || !allowed) {
      return {
        content: `Not added: KT-${number} isn't one of this person's tickets, so you can't add to it. Check the number against "Tickets already raised".`,
        isError: true,
      };
    }

    if (!takeUpdate(ctx.visitor)) {
      return { content: `Not added: there have been too many ticket updates today. ${fallbackLine} (quoting KT-${number}).`, isError: true };
    }

    const updates = [...(Array.isArray(ticket.updates) ? ticket.updates : []), { at: new Date().toISOString(), text }];
    const { error: saveError } = await admin.from("tickets").update({ updates }).eq("id", ticket.id);

    const inbox = process.env.SUPPORT_INBOX_EMAIL;
    const ref = `KT-${number}`;
    const link = ticketsLink();
    const emailError = inbox
      ? await sendEmail({
          to: inbox,
          replyTo: ticket.email,
          subject: `[Katie Travel] Update to ${ref}: ${ticket.title}`,
          text: [
            `Update to ${ref}: ${ticket.title}${saveError ? " (NOT SAVED to the ticket)" : ""}`,
            "",
            text,
            "",
            link ? `View it in Supabase (Table Editor > tickets, ticket_number ${number}):\n${link}` : "",
            "",
            "Reply to this email to answer them directly.",
          ].join("\n"),
          html: `<h2>Update to ${escapeHtml(ref)}: ${escapeHtml(ticket.title)}${saveError ? " (NOT SAVED to the ticket)" : ""}</h2><p>${escapeHtml(text).replace(/\n/g, "<br>")}</p>${link ? `<p><a href="${link}">View it in Supabase</a> (Table Editor › tickets, ticket_number ${number})</p>` : ""}<p>Reply to this email to answer them directly.</p>`,
        })
      : "SUPPORT_INBOX_EMAIL is not set";

    console.log(
      `🎫 Ticket update: ${ref} · saved: ${saveError ? `no (${saveError.message})` : "yes"} · emailed: ${emailError ? `no (${emailError})` : "yes"}\n   Details: ${text}`,
    );

    if (!saveError && !emailError) {
      return { content: `Added to ${ref} and the team has been emailed the update. Tell them the details were added to ticket ${ref}.`, isError: false };
    }
    if (!saveError) {
      return {
        content: `The details were saved to ${ref}, but emailing the team failed, so they may not see the update straight away. Tell them honestly. ${fallbackLine} (quoting ${ref}).`,
        isError: true,
      };
    }
    if (!emailError) {
      return {
        content: `The details couldn't be saved to ${ref}, but the team was emailed them. Tell them honestly that the team has the update even though the ticket itself wasn't updated.`,
        isError: true,
      };
    }
    return {
      content: `Not added: saving to ${ref} and emailing the team both failed. Apologise and tell them honestly. ${fallbackLine} (quoting ${ref}).`,
      isError: true,
    };
  };
}

function takeUpdate(visitor: string): boolean {
  const today = new Date().toISOString().slice(0, 10);
  if (updatesToday.day !== today) {
    updatesToday.day = today;
    updatesToday.counts.clear();
  }
  const used = updatesToday.counts.get(visitor) ?? 0;
  if (used >= DAILY_UPDATE_LIMIT) return false;
  updatesToday.counts.set(visitor, used + 1);
  return true;
}
