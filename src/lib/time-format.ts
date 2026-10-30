/**
 * Clock and timestamp display. Every time the app shows uses the 12-hour clock ("9:00 AM") and,
 * for stored instants, the practice's own time zone. Date-only values ("YYYY-MM-DD") use dates.ts.
 */

/** The common US zones, offered first on the Settings page. */
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

/**
 * Older names some ICU builds still list, with the current IANA name people look for. The current
 * name is offered (and stored) when this runtime accepts it.
 */
const RENAMED_ZONES: Record<string, string> = {
  "Asia/Calcutta": "Asia/Kolkata",
  "Asia/Katmandu": "Asia/Kathmandu",
  "Asia/Saigon": "Asia/Ho_Chi_Minh",
  "Asia/Rangoon": "Asia/Yangon",
  "Europe/Kiev": "Europe/Kyiv",
  "Atlantic/Faeroe": "Atlantic/Faroe",
  "America/Godthab": "America/Nuuk",
  "Pacific/Truk": "Pacific/Chuuk",
  "Pacific/Ponape": "Pacific/Pohnpei",
  "Pacific/Enderbury": "Pacific/Kanton",
};

let allZones: string[] | null = null;

/**
 * Every IANA zone this runtime supports (Intl.supportedValuesOf("timeZone")), with current names in
 * place of renamed ones, plus UTC. Sorted.
 */
export function allTimeZones(): string[] {
  if (allZones) return allZones;
  const listed =
    typeof Intl.supportedValuesOf === "function" ? Intl.supportedValuesOf("timeZone") : ([] as string[]);
  const out = new Set<string>();
  for (const z of listed) {
    const renamed = RENAMED_ZONES[z];
    out.add(renamed && isTimeZone(renamed) ? renamed : z);
  }
  for (const z of PRACTICE_TIME_ZONES) out.add(z.value);
  out.add("UTC");
  allZones = [...out].sort();
  return allZones;
}

/** A zone a practice may choose: one of allTimeZones(). */
export function isPracticeTimeZone(tz: unknown): tz is string {
  if (typeof tz !== "string" || !tz) return false;
  return allTimeZones().includes(tz) || (Object.values(RENAMED_ZONES).includes(tz) && isTimeZone(tz));
}

/** "Europe/London" as "London", "America/Argentina/Buenos_Aires" as "Buenos Aires, Argentina". */
function cityName(tz: string): string {
  const parts = tz
    .split("/")
    .slice(1)
    .map((p) => p.replace(/_/g, " "));
  return parts.length ? parts.reverse().join(", ") : tz;
}

export type TimeZoneGroup = { label: string; options: { value: string; label: string }[] };

/**
 * The Settings choices: the common US zones first, then every other zone grouped by region
 * ("Europe": "London (Europe/London)"), alphabetical within each group.
 */
export function timeZoneGroups(): TimeZoneGroup[] {
  const us = new Set<string>(PRACTICE_TIME_ZONES.map((z) => z.value));
  const groups = new Map<string, { value: string; label: string }[]>();
  for (const z of allTimeZones()) {
    if (us.has(z)) continue;
    const region = z.includes("/") ? z.split("/")[0]! : "Other";
    const list = groups.get(region) ?? [];
    list.push({ value: z, label: z.includes("/") ? `${cityName(z)} (${z})` : z });
    groups.set(region, list);
  }
  return [
    {
      label: "Common US zones",
      options: PRACTICE_TIME_ZONES.map((z) => ({ value: z.value, label: `${z.label} (${z.value})` })),
    },
    ...[...groups.entries()]
      .sort(([a], [b]) => (a === "Other" ? 1 : b === "Other" ? -1 : a.localeCompare(b)))
      .map(([label, options]) => ({
        label,
        options: options.sort((a, b) => a.label.localeCompare(b.label)),
      })),
  ];
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

function dateTimeFormatter(tz: string, seconds: boolean, zoneName: "shortGeneric" | "short") {
  const key = `${tz}|${seconds ? 1 : 0}|${zoneName}`;
  let f = formatters.get(key);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      ...(seconds ? { second: "2-digit" } : {}),
      hour12: true,
      timeZoneName: zoneName,
    });
    formatters.set(key, f);
  }
  return f;
}

/** A zone label short enough to sit after a time: "ET", "MST", "GMT", "UTC". */
const SHORT_ZONE = /^[A-Z]{2,5}$/;

/**
 * A stored instant as "Oct 30, 2026, 11:00 PM ET" in the practice's zone (Eastern if unknown).
 * The zone is its short generic name where there is one ("ET", "PT"), otherwise its short name or
 * GMT offset ("GMT", "GMT+5:30").
 */
export function formatDateTime(
  date: Date,
  timeZone: string | null | undefined,
  opts: { seconds?: boolean } = {},
): string {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) throw new RangeError("Invalid date");
  const tz = timeZone && isTimeZone(timeZone) ? timeZone : DEFAULT_TIME_ZONE;
  const seconds = !!opts.seconds;
  let parts = dateTimeFormatter(tz, seconds, "shortGeneric").formatToParts(date);
  const generic = parts.find((p) => p.type === "timeZoneName")?.value ?? "";
  if (!SHORT_ZONE.test(generic)) parts = dateTimeFormatter(tz, seconds, "short").formatToParts(date);
  // Some ICU builds put a narrow no-break space before AM/PM; show a plain space.
  return parts
    .map((p) => p.value)
    .join("")
    .replace(/[\u202f\u00a0]/g, " ");
}

const dayFormatters = new Map<string, Intl.DateTimeFormat>();

/** The calendar day ("YYYY-MM-DD") a stored instant falls on in the practice's zone (Eastern if unknown). */
export function dayInZone(date: Date, timeZone: string | null | undefined): string {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) throw new RangeError("Invalid date");
  const tz = timeZone && isTimeZone(timeZone) ? timeZone : DEFAULT_TIME_ZONE;
  let f = dayFormatters.get(tz);
  if (!f) {
    // en-CA formats a date as YYYY-MM-DD.
    f = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" });
    dayFormatters.set(tz, f);
  }
  const parts = Object.fromEntries(f.formatToParts(date).map((p) => [p.type, p.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}
