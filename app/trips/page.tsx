import { redirect } from "next/navigation";
import { createClient, currentUser } from "@/lib/supabase/server";
import { deleteTrip, renameTrip } from "./actions";
import DeleteTripButton from "./delete-button";

// "Your trips": every saved trip, most recently active first.
export default async function TripsPage() {
  const supabase = await createClient();
  const user = await currentUser(supabase);
  if (!user) redirect("/");

  const { data: trips } = await supabase
    .from("trips")
    .select("id, title, updated_at")
    .order("updated_at", { ascending: false });

  return (
    <main className="trips">
      <div className="trips-card">
        <header className="trips-header">
          <h1>Your trips</h1>
          <nav className="header-links">
            <a href="/">New trip</a>
            <a href="/preferences">Preferences</a>
          </nav>
        </header>

        {!trips?.length ? (
          <p className="small">
            No trips yet. <a href="/">Start planning one</a> and it will be saved here automatically.
          </p>
        ) : (
          <ul className="trip-list">
            {trips.map((trip) => (
              <li key={trip.id} className="trip-item">
                <a href={`/trips/${trip.id}`} className="trip-link">
                  <span className="trip-title">{trip.title}</span>
                  <span className="small">
                    Last updated{" "}
                    {new Date(trip.updated_at).toLocaleDateString("en-GB", {
                      day: "numeric",
                      month: "short",
                      year: "numeric",
                    })}
                  </span>
                </a>
                <div className="trip-actions">
                  <form action={renameTrip} className="rename-form">
                    <input type="hidden" name="id" value={trip.id} />
                    <input name="title" defaultValue={trip.title} maxLength={120} aria-label={`Rename ${trip.title}`} required />
                    <button type="submit" className="link-button">
                      Rename
                    </button>
                  </form>
                  <form action={deleteTrip}>
                    <input type="hidden" name="id" value={trip.id} />
                    <DeleteTripButton title={trip.title} />
                  </form>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </main>
  );
}
