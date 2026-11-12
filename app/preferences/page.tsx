import { redirect } from "next/navigation";
import { MAX_PREFERENCE_LENGTH, PREFERENCE_FIELDS, type Profile } from "@/lib/profile";
import { createClient, currentUser } from "@/lib/supabase/server";
import { savePreferences, skipPreferences } from "./actions";

// One screen of optional travel preferences. Shown once after first sign-in (with
// "Skip for now"), and reachable any time from the Preferences link.
export default async function PreferencesPage({
  searchParams,
}: {
  searchParams: Promise<{ first?: string; error?: string }>;
}) {
  const supabase = await createClient();
  const user = await currentUser(supabase);
  if (!user) redirect("/");

  const { first, error } = await searchParams;
  const { data } = await supabase.from("profiles").select("*").eq("user_id", user.id).maybeSingle();
  const profile = (data ?? {}) as Profile;
  const isFirstVisit = Boolean(first) || !data;

  return (
    <main className="prefs">
      <form action={savePreferences} className="prefs-card">
        <h1>{isFirstVisit ? "A few quick preferences" : "Your travel preferences"}</h1>
        <p className="small">
          All optional. Katie will use these in every conversation and check they still apply, so you don&apos;t
          have to repeat yourself. You can change them any time.
        </p>
        {error && (
          <p className="access-error" role="alert">
            Something went wrong saving that. Please try again.
          </p>
        )}

        <div className="prefs-grid">
          {PREFERENCE_FIELDS.map((field) => (
            <label key={field.column} className="prefs-field">
              <span>{field.label}</span>
              {field.options ? (
                <select name={field.column} defaultValue={profile[field.column] ?? ""}>
                  <option value="">No preference</option>
                  {field.options.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </select>
              ) : (
                <input
                  name={field.column}
                  defaultValue={profile[field.column] ?? ""}
                  placeholder={field.hint}
                  maxLength={MAX_PREFERENCE_LENGTH}
                />
              )}
            </label>
          ))}
        </div>

        <div className="prefs-actions">
          <button type="submit">Save preferences</button>
          {isFirstVisit ? (
            <button type="submit" formAction={skipPreferences} formNoValidate className="secondary">
              Skip for now
            </button>
          ) : (
            <a href="/" className="secondary">
              Cancel
            </a>
          )}
        </div>
      </form>
    </main>
  );
}
