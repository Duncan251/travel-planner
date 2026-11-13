import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { createClient, currentUser } from "@/lib/supabase/server";

export const metadata: Metadata = { title: "Delete your account · Travel Planner" };

const ERRORS: Record<string, string> = {
  confirm: 'Please type DELETE in the box to confirm.',
  failed: "Something went wrong and nothing was deleted. Please try again, or ask Amber, our support assistant, using the Help button.",
};

// The confirmation step before an account is deleted.
export default async function DeleteAccountPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const supabase = await createClient();
  const user = await currentUser(supabase);
  if (!user) redirect("/");
  const { error } = await searchParams;

  return (
    <main className="doc">
      <article className="doc-card markdown">
        <a href="/privacy" className="small">
          ← Back to Privacy
        </a>
        <h1>Delete your account and data</h1>
        <p>
          This permanently deletes the account for <strong>{user.email}</strong> and everything stored with it:
        </p>
        <ul>
          <li>your sign-in account</li>
          <li>your travel preferences</li>
          <li>all your trips, itineraries and conversations with Katie</li>
          <li>your daily message counts</li>
        </ul>
        <p>
          <strong>This can&apos;t be undone.</strong> If you sign in again later with the same email, you&apos;ll start
          with a new, empty account.
        </p>

        <form method="post" action="/api/account/delete" className="delete-form">
          <label htmlFor="confirm">Type DELETE to confirm</label>
          <input id="confirm" name="confirm" autoComplete="off" autoCapitalize="characters" required />
          {error && ERRORS[error] && (
            <p className="access-error" role="alert">
              {ERRORS[error]}
            </p>
          )}
          <div className="row">
            <button type="submit" className="danger-submit">
              Permanently delete
            </button>
            <a href="/privacy">Cancel</a>
          </div>
        </form>
      </article>
    </main>
  );
}
