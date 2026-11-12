import type Anthropic from "@anthropic-ai/sdk";
import type { ToolOutput } from "./types";

// Real places (restaurants, cafes, sights...) from the Google Places API (New) Text Search.
// Needs GOOGLE_PLACES_API_KEY on the server.

const ENDPOINT = "https://places.googleapis.com/v1/places:searchText";
const DAILY_LIMIT = 30;
const MAX_RESULTS = 5;
const TIMEOUT_MS = 10_000;

// Only these fields are requested, and Google bills each search by the priciest field asked for.
// rating, priceLevel, regularOpeningHours and websiteUri are Enterprise fields, so every search is
// billed as "Text Search Enterprise". Preferences go into the search text rather than requesting
// Atmosphere fields (servesVegetarianFood, reviews...), which would move it up to a dearer tier.
const FIELD_MASK = [
  "places.displayName",
  "places.formattedAddress",
  "places.businessStatus", // to drop permanently closed places
  "places.rating",
  "places.priceLevel",
  "places.regularOpeningHours",
  "places.websiteUri",
].join(",");

export const findPlacesTool: Anthropic.Tool = {
  name: "find_places",
  description: `Search Google for real places of a given kind in a specific area: restaurants, cafes, bars, museums, sights, shops and so on. Returns up to ${MAX_RESULTS} matches, each with name, address, Google rating, price level and website, plus whether it's normally open on a given date if you supply one.

When to use it: while drafting or refining an itinerary (Stage 3 onwards), to recommend specific real places rather than generic ones, to check that a place you're about to suggest really exists, or when the traveller asks for somewhere specific ("a good pub near our hotel"). Don't use it in the first few messages while you're still learning the basics and their travel style; ask your questions first. Search only for what you're about to recommend, one search per kind of place and area, rather than searching speculatively.

Using the results: recommend only places that appear in the results, using their exact names. Check each address is actually in the area you searched: when nothing nearby fits, Google may return matches from elsewhere, even another country, so ignore those, and if none are left, treat it as no matches. The website comes from Google, so you may share it exactly as given; never alter or guess a web address. Ratings are Google user ratings out of 5. "open_on_date" is based on regular weekly hours and doesn't account for public holidays, so suggest the traveller checks nearer the time.

If the result is an error, has no matches, or says the daily search limit is reached, tell the traveller plainly and describe the kind of place to look for instead. Never invent names.`,
  eager_input_streaming: true,
  input_schema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: 'What to look for, e.g. "seafood restaurant", "cafe", "pub", "museum".',
      },
      location: {
        type: "string",
        description: 'Where to look: a neighbourhood or place, with the city, e.g. "Alfama, Lisbon" or "near Trevi Fountain, Rome".',
      },
      preferences: {
        type: "array",
        items: { type: "string" },
        description: 'Optional extra wishes, e.g. ["vegetarian", "quiet", "good views"].',
      },
      date: {
        type: "string",
        description: "Optional date of the visit, as YYYY-MM-DD, to check whether each place is normally open that day.",
      },
    },
    required: ["query", "location"],
    additionalProperties: false,
  },
};

type GoogleTime = { day: number; hour?: number; minute?: number };

type GooglePlace = {
  displayName?: { text: string };
  formattedAddress?: string;
  businessStatus?: string;
  rating?: number;
  priceLevel?: string;
  regularOpeningHours?: {
    periods?: { open?: GoogleTime; close?: GoogleTime }[];
    weekdayDescriptions?: string[]; // Monday first
  };
  websiteUri?: string;
};

const PRICE_LEVELS: Record<string, string> = {
  PRICE_LEVEL_FREE: "free",
  PRICE_LEVEL_INEXPENSIVE: "inexpensive ($)",
  PRICE_LEVEL_MODERATE: "moderate ($$)",
  PRICE_LEVEL_EXPENSIVE: "expensive ($$$)",
  PRICE_LEVEL_VERY_EXPENSIVE: "very expensive ($$$$)",
};

// Searches so far today. Kept on globalThis so it survives Next.js reloading this file
// during development; it resets when the server restarts.
const usage: { day: string; count: number } = ((globalThis as { __placesUsage?: { day: string; count: number } })
  .__placesUsage ??= { day: "", count: 0 });

export async function findPlaces(input: unknown): Promise<ToolOutput> {
  const parsed = parseInput(input);
  if (typeof parsed === "string") return fail(parsed);
  const { query, location, preferences, date } = parsed;

  const apiKey = process.env.GOOGLE_PLACES_API_KEY;
  if (!apiKey) return fail("place search isn't set up on the server (GOOGLE_PLACES_API_KEY is missing).");

  if (!takeSearch()) {
    return fail(`Search limit reached for today (${DAILY_LIMIT} searches). It resets tomorrow.`);
  }

  const textQuery = `${[...preferences, query].join(" ")} in ${location}`;
  let places: GooglePlace[];
  try {
    places = await search(textQuery, apiKey);
  } catch (err) {
    return fail(`Google's place search failed (${errorText(err)}).`);
  }

  const results = places
    .filter((p) => p.displayName?.text && p.businessStatus !== "CLOSED_PERMANENTLY")
    .slice(0, MAX_RESULTS)
    .map((p) => ({
      name: p.displayName!.text,
      address: p.formattedAddress ?? null,
      rating: p.rating ?? null,
      price_level: p.priceLevel ? (PRICE_LEVELS[p.priceLevel] ?? null) : null,
      ...(p.businessStatus === "CLOSED_TEMPORARILY" ? { note: "temporarily closed" } : {}),
      ...(date ? { open_on_date: openOn(p, date) } : {}),
      website: p.websiteUri ?? null,
    }));

  if (results.length === 0) {
    return fail(`Google found no open matches for "${textQuery}". Try a broader search or a nearby area.`);
  }

  return { content: JSON.stringify({ search: textQuery, results }, null, 2), isError: false };
}

// ---- Input checks ----

function parseInput(
  input: unknown,
): { query: string; location: string; preferences: string[]; date?: string } | string {
  const { query, location, preferences, date } = (input ?? {}) as Record<string, unknown>;
  if (typeof query !== "string" || !query.trim()) return "Missing what to look for (query).";
  if (typeof location !== "string" || !location.trim()) return "Missing where to look (location).";
  if (preferences !== undefined && !(Array.isArray(preferences) && preferences.every((p) => typeof p === "string"))) {
    return "preferences must be a list of short words or phrases.";
  }
  if (date !== undefined && !isValidDate(date)) return "date must be a real calendar date written as YYYY-MM-DD.";
  return {
    query: query.trim(),
    location: location.trim(),
    preferences: ((preferences as string[] | undefined) ?? []).map((p) => p.trim()).filter(Boolean),
    date: date as string | undefined,
  };
}

function isValidDate(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value
  );
}

// ---- Daily limit ----

function takeSearch(): boolean {
  const today = new Date().toISOString().slice(0, 10);
  if (usage.day !== today) {
    usage.day = today;
    usage.count = 0;
  }
  if (usage.count >= DAILY_LIMIT) return false;
  usage.count++;
  return true;
}

// ---- Google call ----

async function search(textQuery: string, apiKey: string): Promise<GooglePlace[]> {
  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Goog-Api-Key": apiKey,
      "X-Goog-FieldMask": FIELD_MASK,
    },
    body: JSON.stringify({ textQuery, pageSize: 10, languageCode: "en" }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const body = await res.json().catch(() => null);
  if (!res.ok || !body) {
    throw new Error(body?.error?.message ?? `HTTP ${res.status}`);
  }
  return (body.places ?? []) as GooglePlace[];
}

// ---- Opening hours ----

function openOn(place: GooglePlace, date: string) {
  const dayIndex = new Date(`${date}T00:00:00Z`).getUTCDay(); // 0 = Sunday, as Google uses
  const weekday = new Date(`${date}T00:00:00Z`).toLocaleDateString("en-GB", { weekday: "long", timeZone: "UTC" });
  const hours = place.regularOpeningHours;
  if (!hours?.periods?.length) return { date, weekday, open: "unknown (no hours listed)" };

  // A single period with no closing time means open 24 hours, every day.
  const alwaysOpen = hours.periods.length === 1 && !hours.periods[0].close;
  const open = alwaysOpen || hours.periods.some((p) => p.open?.day === dayIndex);
  const listed = hours.weekdayDescriptions?.[(dayIndex + 6) % 7]; // descriptions start on Monday
  return { date, weekday, open, ...(listed ? { hours: listed } : {}) };
}

// ---- Small helpers ----

function fail(message: string): ToolOutput {
  return { content: `Place search unavailable: ${message}`, isError: true };
}

function errorText(err: unknown): string {
  if (err instanceof Error && err.name === "TimeoutError") return "it took too long to respond";
  return err instanceof Error ? err.message : String(err);
}
