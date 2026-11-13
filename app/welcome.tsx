"use client";

import { useActionState } from "react";
import { sendMagicLink, type SignInState } from "./auth/actions";

// The page signed-out visitors see: a short welcome and an email box for a sign-in link.
export default function Welcome({ linkFailed, accountDeleted = false }: { linkFailed: boolean; accountDeleted?: boolean }) {
  const [state, formAction, pending] = useActionState<SignInState, FormData>(sendMagicLink, {
    sent: false,
    error: linkFailed ? "That sign-in link didn't work. It may have expired or already been used. Request a new one below." : "",
  });

  return (
    <main className="access">
      <div className="access-card">
        <h1>Travel Planner</h1>
        {accountDeleted && (
          <p className="notice" role="status">
            Your account and all its data have been deleted.
          </p>
        )}
        <p>Meet Katie, your trip-planning companion. She'll help you shape a trip day by day, with real weather and real places.</p>

        {state.sent ? (
          <p className="notice" role="status">
            Check your inbox for a sign-in link. You can close this tab; the link signs you in.
          </p>
        ) : (
          <form action={formAction} className="stack">
            <label htmlFor="email">Sign in with your email</label>
            <input id="email" name="email" type="email" required autoComplete="email" placeholder="you@example.com" />
            {state.error && (
              <p className="access-error" role="alert">
                {state.error}
              </p>
            )}
            <button type="submit" disabled={pending}>
              {pending ? "Sending…" : "Email me a sign-in link"}
            </button>
            <p className="small">No password needed. We'll email you a one-time link.</p>
          </form>
        )}
      </div>
    </main>
  );
}
