import { USER_AGENT } from "./http.js";

/**
 * Seven-day forecasts for the capital cities from Open-Meteo (free for non-commercial sites, data CC BY 4.0, credit
 * required). The Bureau of Meteorology's own forecasts may not be republished or scraped (bom.gov.au copyright page),
 * and Open-Meteo no longer serves the Bureau's ACCESS model, so this is Open-Meteo's best blend of national models.
 */
export interface City {
  id: string;
  name: string;
  state: string;
  latitude: number;
  longitude: number;
  /** Browser time zones that make this the reader's default city. */
  timeZones: string[];
}

export const CITIES: readonly City[] = [
  { id: "perth", name: "Perth", state: "WA", latitude: -31.95, longitude: 115.86, timeZones: ["Australia/Perth", "Australia/West"] },
  { id: "adelaide", name: "Adelaide", state: "SA", latitude: -34.93, longitude: 138.6, timeZones: ["Australia/Adelaide", "Australia/South", "Australia/Broken_Hill"] },
  { id: "darwin", name: "Darwin", state: "NT", latitude: -12.46, longitude: 130.84, timeZones: ["Australia/Darwin", "Australia/North"] },
  { id: "brisbane", name: "Brisbane", state: "QLD", latitude: -27.47, longitude: 153.03, timeZones: ["Australia/Brisbane", "Australia/Queensland", "Australia/Lindeman"] },
  { id: "sydney", name: "Sydney", state: "NSW", latitude: -33.87, longitude: 151.21, timeZones: ["Australia/Sydney", "Australia/NSW", "Australia/ACT", "Australia/Canberra"] },
  { id: "canberra", name: "Canberra", state: "ACT", latitude: -35.28, longitude: 149.13, timeZones: [] },
  { id: "melbourne", name: "Melbourne", state: "VIC", latitude: -37.81, longitude: 144.96, timeZones: ["Australia/Melbourne", "Australia/Victoria"] },
  { id: "hobart", name: "Hobart", state: "TAS", latitude: -42.88, longitude: 147.33, timeZones: ["Australia/Hobart", "Australia/Tasmania", "Australia/Currie"] },
];

export interface Day {
  /** Local calendar date, YYYY-MM-DD. */
  date: string;
  code: number;
  max: number;
  min: number;
  /** Highest chance of rain during the day, in per cent. */
  rain: number;
  /** Expected rain in millimetres. */
  mm: number;
}

export interface Forecast {
  city: City;
  days: Day[];
}

const API = "https://api.open-meteo.com/v1/forecast";
const DAYS = 7;
const TIMEOUT_MS = 15_000;

/** Every capital in one request; null when Open-Meteo can't be reached, and the site leaves the weather out. */
export async function loadWeather(): Promise<Forecast[] | null> {
  const params = new URLSearchParams({
    latitude: CITIES.map((c) => c.latitude).join(","),
    longitude: CITIES.map((c) => c.longitude).join(","),
    daily: "weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,precipitation_sum",
    timezone: "auto",
    forecast_days: String(DAYS),
  });
  try {
    const res = await fetch(`${API}?${params}`, { headers: { "user-agent": USER_AGENT }, signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok) throw new Error(`Open-Meteo ${res.status}`);
    const body = (await res.json()) as any[];
    const forecasts = CITIES.map((city, n) => {
      const d = body[n]?.daily ?? {};
      const days: Day[] = ((d.time ?? []) as string[]).map((date, i) => ({
        date,
        code: d.weather_code?.[i],
        max: Math.round(d.temperature_2m_max?.[i]),
        min: Math.round(d.temperature_2m_min?.[i]),
        rain: Math.round(d.precipitation_probability_max?.[i] ?? 0),
        mm: Math.round((d.precipitation_sum?.[i] ?? 0) * 10) / 10,
      }));
      return { city, days: days.filter((x) => Number.isFinite(x.max) && Number.isFinite(x.min) && Number.isFinite(x.code)) };
    });
    if (forecasts.some((f) => f.days.length < DAYS)) throw new Error("incomplete forecast");
    return forecasts;
  } catch (err) {
    console.log(`Weather unavailable: ${err instanceof Error ? err.message : err}`);
    return null;
  }
}

/**
 * WMO weather codes, as Open-Meteo reports them, in plain words with an icon. A day's code is its most notable hour,
 * so "drizzle" can come with a wet day's total; the expected rain (mm) decides the wording then.
 */
export function describe(code: number, mm = 0): { text: string; icon: string } {
  const wet = (code >= 51 && code <= 67) || (code >= 80 && code <= 82);
  if (wet && mm >= 20) return { text: "Heavy rain", icon: "🌧️" };
  if (wet && mm >= 5) return { text: "Rain", icon: "🌧️" };
  if (code === 0) return { text: "Sunny", icon: "☀️" };
  if (code === 1) return { text: "Mostly sunny", icon: "🌤️" };
  if (code === 2) return { text: "Partly cloudy", icon: "⛅" };
  if (code === 3) return { text: "Cloudy", icon: "☁️" };
  if (code === 45 || code === 48) return { text: "Fog", icon: "🌫️" };
  if (code >= 51 && code <= 57) return { text: "Drizzle", icon: "🌦️" };
  if (code === 61 || code === 80) return { text: "Light rain", icon: "🌦️" };
  if ((code >= 62 && code <= 67) || (code >= 81 && code <= 82)) return { text: "Rain", icon: "🌧️" };
  if ((code >= 71 && code <= 77) || code === 85 || code === 86) return { text: "Snow", icon: "🌨️" };
  if (code >= 95) return { text: "Storms", icon: "⛈️" };
  return { text: "Mixed", icon: "🌥️" };
}
