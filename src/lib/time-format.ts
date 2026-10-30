/**
 * Clock and timestamp display. Every time the app shows uses the 12-hour clock ("9:00 AM") and,
 * for stored instants, the practice's own time zone. Date-only values ("YYYY-MM-DD") use dates.ts.
 */

/** The US zones a practice picks from on the Settings page. */
export const PRACTICE_TIME_ZONES = [
  { value: "America/New_York", label: "Eastern" },
  { value: "America/Chicago", label: "Central" },
  { value: "America/Denver", label: "Mountain" },
  { value: "America/Phoenix", label: "Arizona" },
  { value: "America/Los_Angeles", label: "Pacific" },
  { value: "America/Anchorage", label: "Alaska" },
  { value: "Pacific/Honolulu", label: "Hawaii" },
] as const;

export type PracticeTimeZone = (typeof PRACTICE_TIME_ZONES)[number]["value"];
export const PRACTICE_TIME_ZONE_IDS = PRACTICE_TIME_ZONES.map((z) => z.value) as [
  PracticeTimeZone,
  ...PracticeTimeZone[],
];
export const DEFAULT_TIME_ZONE: PracticeTimeZone = "America/New_York";

export function isTimeZone(tz: string): boolean {
  if (!tz) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Minutes since midnight (0–1439) as "9:00 AM". */
export function formatClock(minutes: number): string {
  if (!Number.isInteger(minutes) || minutes < 0 || minutes >= 24 * 60)
    throw new RangeError("Not a minute of the day");
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${String(m).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

/** A stored instant as "Oct 30, 2026, 11:00 PM ET" in the practice's zone (Eastern if unknown). */
export function formatDateTime(
  date: Date,
  timeZone: string | null | undefined,
  opts: { seconds?: boolean } = {},
): string {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) throw new RangeError("Invalid date");
  const tz = timeZone && isTimeZone(timeZone) ? timeZone : DEFAULT_TIME_ZONE;
  const key = `${tz}|${opts.seconds ? 1 : 0}`;
  let f = formatters.get(key);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      ...(opts.seconds ? { second: "2-digit" } : {}),
      hour12: true,
      timeZoneName: "shortGeneric",
    });
    formatters.set(key, f);
  }
  // Some ICU builds put a narrow no-break space before AM/PM; show a plain space.
  return f.format(date).replace(/[  ]/g, " ");
}
