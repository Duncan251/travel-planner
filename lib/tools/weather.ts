import type Anthropic from "@anthropic-ai/sdk";

// Weather for a place and date range, using Open-Meteo's free APIs (no key needed).
// Within the forecast window it returns the daily forecast; beyond it, typical
// conditions averaged from the same dates in recent years.

const FORECAST_DAYS = 14;
const TYPICAL_YEARS = 5;
const MAX_RANGE_DAYS = 31;
const TIMEOUT_MS = 10_000;

export const getWeatherTool: Anthropic.Tool = {
  name: "get_weather",
  description: `Get the weather for one place over a date range.

Use this whenever the traveller's plans depend on the weather: once you know a destination and approximate dates, when they ask what to pack, whether a day suits the beach or outdoor sightseeing, or when you are drafting or refining an itinerary and need to decide on rain plans. Don't call it before you know at least the destination and rough dates; ask first.

For dates within the next ${FORECAST_DAYS} days it returns the daily forecast: high and low temperature in °C, chance of rain, and conditions. For dates further ahead it returns typical conditions for that time of year, averaged from the same dates over the last ${TYPICAL_YEARS} years. That part is labelled "typical, not a forecast" and must always be presented to the traveller that way, never as a forecast. A range that crosses the ${FORECAST_DAYS}-day line returns both parts.

Call it once per destination. For a multi-stop trip, call it separately for each place with the dates for that leg; you can make several calls at once. Ranges are limited to ${MAX_RANGE_DAYS} days.

If the result is an error (place not found, or the weather service unavailable), tell the traveller plainly that you couldn't get the weather and why. Don't guess or fill in numbers from memory.`,
  eager_input_streaming: true,
  input_schema: {
    type: "object",
    properties: {
      place: {
        type: "string",
        description: 'City or town, optionally followed by region or country to avoid mix-ups, e.g. "Lisbon, Portugal" or "Portland, Oregon".',
      },
      start_date: { type: "string", description: "First day, as YYYY-MM-DD." },
      end_date: { type: "string", description: "Last day, as YYYY-MM-DD. Same as start_date for a single day." },
    },
    required: ["place", "start_date", "end_date"],
    additionalProperties: false,
  },
};

export type ToolOutput = { content: string; isError: boolean };

type Place = {
  name: string;
  latitude: number;
  longitude: number;
  country?: string;
  country_code?: string;
  admin1?: string;
};

type DailyResponse = { daily: Record<string, (number | null)[]> & { time: string[] } };

export async function getWeather(input: unknown): Promise<ToolOutput> {
  const parsed = parseInput(input);
  if (typeof parsed === "string") return fail(parsed);
  const { place, startDate, endDate } = parsed;

  const today = isoDate(new Date());
  if (endDate < today) {
    return fail(`Those dates (${startDate} to ${endDate}) are in the past. Ask for future dates.`);
  }

  let location: Place | null;
  try {
    location = await geocode(place);
  } catch (err) {
    return fail(`Couldn't reach Open-Meteo's place search (${errorText(err)}), so the weather is unavailable right now.`);
  }
  if (!location) {
    return fail(`No place called "${place}" was found. Check the spelling, or ask the traveller for a nearby larger town.`);
  }

  const result: Record<string, unknown> = {
    location: [location.name, location.admin1, location.country].filter(Boolean).join(", "),
    requested_dates: `${startDate} to ${endDate}`,
  };

  let from = startDate;
  if (from < today) {
    result.note = `The range started in the past, so only ${today} onwards is covered.`;
    from = today;
  }

  const lastForecastDay = addDays(today, FORECAST_DAYS - 1);
  try {
    if (from <= lastForecastDay) {
      result.forecast = await forecast(location, from, minDate(endDate, lastForecastDay));
    }
    if (endDate > lastForecastDay) {
      result.typical = await typical(location, maxDate(from, addDays(lastForecastDay, 1)), endDate);
    }
  } catch (err) {
    return fail(`Open-Meteo's weather service failed (${errorText(err)}), so the weather is unavailable right now.`);
  }

  return { content: JSON.stringify(result, null, 2), isError: false };
}

// ---- Input checks ----

function parseInput(input: unknown): { place: string; startDate: string; endDate: string } | string {
  const { place, start_date, end_date } = (input ?? {}) as Record<string, unknown>;
  if (typeof place !== "string" || !place.trim()) return "Missing the place name.";
  if (!isValidDate(start_date) || !isValidDate(end_date)) {
    return "Dates must be real calendar dates written as YYYY-MM-DD.";
  }
  if (end_date < start_date) return "end_date is before start_date.";
  if (daysBetween(start_date, end_date) + 1 > MAX_RANGE_DAYS) {
    return `That range is longer than ${MAX_RANGE_DAYS} days. Split it into shorter legs.`;
  }
  return { place: place.trim(), startDate: start_date, endDate: end_date };
}

function isValidDate(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) && isoDate(new Date(`${value}T00:00:00Z`)) === value;
}

// ---- Open-Meteo calls ----

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  const body = await res.json().catch(() => null);
  if (!res.ok || !body || body.error) {
    throw new Error(body?.reason ?? `HTTP ${res.status}`);
  }
  return body as T;
}

async function geocode(place: string): Promise<Place | null> {
  // "Lisbon, Portugal": search for "Lisbon", then prefer a match in Portugal.
  const [name, ...rest] = place.split(",").map((part) => part.trim()).filter(Boolean);
  const hint = rest.join(" ").toLowerCase();
  const url = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(name)}&count=10&language=en&format=json`;
  const { results = [] } = await fetchJson<{ results?: Place[] }>(url);
  if (results.length === 0) return null;
  const preferred = hint
    ? results.find((r) => [r.country, r.admin1, r.country_code].some((v) => v && hint.includes(v.toLowerCase())))
    : undefined;
  return preferred ?? results[0];
}

async function forecast(location: Place, start: string, end: string) {
  const url =
    `https://api.open-meteo.com/v1/forecast?latitude=${location.latitude}&longitude=${location.longitude}` +
    `&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max,weather_code` +
    `&timezone=auto&start_date=${start}&end_date=${end}`;
  const { daily } = await fetchJson<DailyResponse>(url);
  return {
    label: "forecast",
    days: daily.time.map((date, i) => ({
      date,
      weekday: weekday(date),
      high_c: round(daily.temperature_2m_max[i]),
      low_c: round(daily.temperature_2m_min[i]),
      chance_of_rain_pct: daily.precipitation_probability_max[i],
      conditions: describeCode(daily.weather_code[i]),
    })),
  };
}

async function typical(location: Place, start: string, end: string) {
  // Use the most recent years whose dates have already passed (the archive lags by
  // about a week), e.g. a January 2027 trip uses January 2022–2026.
  const archiveEnd = addDays(isoDate(new Date()), -7);
  let firstBack = 1;
  while (shiftYears(end, -firstBack) > archiveEnd) firstBack++;
  const years = Array.from({ length: TYPICAL_YEARS }, (_, i) => firstBack + i);

  const histories = await Promise.all(
    years.map((back) => {
      const url =
        `https://archive-api.open-meteo.com/v1/archive?latitude=${location.latitude}&longitude=${location.longitude}` +
        `&daily=temperature_2m_max,temperature_2m_min,precipitation_sum,weather_code` +
        `&timezone=auto&start_date=${shiftYears(start, -back)}&end_date=${shiftYears(end, -back)}`;
      return fetchJson<DailyResponse>(url);
    }),
  );

  const highs: number[] = [];
  const lows: number[] = [];
  const rain: number[] = [];
  const conditions = new Map<string, number>();
  for (const { daily } of histories) {
    daily.time.forEach((_, i) => {
      const hi = daily.temperature_2m_max[i];
      const lo = daily.temperature_2m_min[i];
      const mm = daily.precipitation_sum[i];
      const code = daily.weather_code[i];
      if (hi !== null) highs.push(hi);
      if (lo !== null) lows.push(lo);
      if (mm !== null) rain.push(mm);
      if (code !== null) {
        const kind = conditionGroup(code);
        conditions.set(kind, (conditions.get(kind) ?? 0) + 1);
      }
    });
  }
  if (highs.length === 0) throw new Error("no historical data for these dates");

  const wetDays = rain.filter((mm) => mm >= 1).length;
  const firstYear = Number(shiftYears(start, -years[years.length - 1]).slice(0, 4));
  const lastYear = Number(shiftYears(start, -years[0]).slice(0, 4));
  return {
    label: "typical, not a forecast",
    dates: `${start} to ${end}`,
    based_on: `Daily weather on the same dates in ${firstYear}–${lastYear} (${TYPICAL_YEARS} years)`,
    average_high_c: round(average(highs)),
    average_low_c: round(average(lows)),
    warmest_high_seen_c: round(Math.max(...highs)),
    coldest_low_seen_c: round(Math.min(...lows)),
    rainy_days_pct: rain.length ? Math.round((wetDays / rain.length) * 100) : null,
    most_common_conditions: [...conditions.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 2)
      .map(([kind]) => kind),
  };
}

// ---- Weather codes (WMO), as used by Open-Meteo ----

const CODE_TEXT: Record<number, string> = {
  0: "clear sky", 1: "mainly clear", 2: "partly cloudy", 3: "overcast",
  45: "fog", 48: "freezing fog",
  51: "light drizzle", 53: "drizzle", 55: "heavy drizzle", 56: "freezing drizzle", 57: "freezing drizzle",
  61: "light rain", 63: "rain", 65: "heavy rain", 66: "freezing rain", 67: "freezing rain",
  71: "light snow", 73: "snow", 75: "heavy snow", 77: "snow grains",
  80: "light showers", 81: "showers", 82: "heavy showers", 85: "snow showers", 86: "heavy snow showers",
  95: "thunderstorms", 96: "thunderstorms with hail", 99: "thunderstorms with hail",
};

function describeCode(code: number | null): string {
  return code === null ? "unknown" : (CODE_TEXT[code] ?? "unknown");
}

function conditionGroup(code: number): string {
  if (code <= 1) return "clear or mostly sunny";
  if (code === 2) return "partly cloudy";
  if (code === 3) return "overcast";
  if (code <= 48) return "fog";
  if (code <= 67 || (code >= 80 && code <= 82)) return "rain or drizzle";
  if (code <= 86) return "snow";
  return "thunderstorms";
}

// ---- Small helpers ----

function fail(message: string): ToolOutput {
  return { content: `Weather unavailable: ${message}`, isError: true };
}

function errorText(err: unknown): string {
  if (err instanceof Error && err.name === "TimeoutError") return "it took too long to respond";
  return err instanceof Error ? err.message : String(err);
}

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return isoDate(d);
}

function shiftYears(date: string, years: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCFullYear(d.getUTCFullYear() + years);
  return isoDate(d);
}

function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(b) - Date.parse(a)) / 86_400_000);
}

function minDate(a: string, b: string): string {
  return a < b ? a : b;
}

function maxDate(a: string, b: string): string {
  return a > b ? a : b;
}

function weekday(date: string): string {
  return new Date(`${date}T00:00:00Z`).toLocaleDateString("en-GB", { weekday: "short", timeZone: "UTC" });
}

function average(values: number[]): number {
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

function round(value: number | null): number | null {
  return value === null ? null : Math.round(value);
}
