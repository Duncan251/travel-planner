import "server-only"; // uses the Resend API key, so never in browser code

// Sends an email through Resend (https://resend.com), using RESEND_API_KEY.
// RESEND_FROM is the sender. Resend's shared test sender only delivers to the address
// your Resend account was created with; verify your own domain in Resend to send elsewhere.

const DEFAULT_FROM = "Katie Travel <onboarding@resend.dev>";
const TIMEOUT_MS = 10_000;

export type Email = { to: string; subject: string; text: string; html: string; replyTo?: string };

// Returns null on success, or a short reason it failed.
export async function sendEmail(email: Email): Promise<string | null> {
  const key = process.env.RESEND_API_KEY;
  if (!key) return "RESEND_API_KEY is not set";

  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: process.env.RESEND_FROM || DEFAULT_FROM,
        to: [email.to],
        subject: email.subject,
        text: email.text,
        html: email.html,
        ...(email.replyTo ? { reply_to: email.replyTo } : {}),
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (res.ok) return null;
    const body = (await res.json().catch(() => null)) as { message?: string } | null;
    return body?.message ?? `Resend returned HTTP ${res.status}`;
  } catch (err) {
    return err instanceof Error && err.name === "TimeoutError" ? "Resend took too long to respond" : String(err);
  }
}

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}
