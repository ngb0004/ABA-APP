import { describe, expect, it } from "vitest";
import {
  DEFAULT_TIME_ZONE,
  PRACTICE_TIME_ZONES,
  allTimeZones,
  dayInZone,
  formatClock,
  formatDateTime,
  isPracticeTimeZone,
  isTimeZone,
  timeZoneGroups,
} from "@/lib/time-format";

describe("formatClock", () => {
  it("shows midnight and noon as 12", () => {
    expect(formatClock(0)).toBe("12:00 AM");
    expect(formatClock(12 * 60)).toBe("12:00 PM");
  });
  it("shows morning, half past noon, and afternoon times", () => {
    expect(formatClock(9 * 60)).toBe("9:00 AM");
    expect(formatClock(12 * 60 + 30)).toBe("12:30 PM");
    expect(formatClock(13 * 60)).toBe("1:00 PM");
    expect(formatClock(23 * 60 + 59)).toBe("11:59 PM");
    expect(formatClock(9 * 60 + 5)).toBe("9:05 AM");
  });
  it("rejects values that are not a minute of the day", () => {
    for (const bad of [-1, 1440, 9.5, Number.NaN, Number.POSITIVE_INFINITY])
      expect(() => formatClock(bad)).toThrow();
  });
});

describe("formatDateTime", () => {
  const t = new Date("2026-10-31T03:00:00Z");
  it("shows the practice's local 12-hour time and zone", () => {
    expect(formatDateTime(t, "America/New_York")).toBe("Oct 30, 2026, 11:00 PM ET");
    expect(formatDateTime(t, "America/Los_Angeles")).toBe("Oct 30, 2026, 8:00 PM PT");
    expect(formatDateTime(t, "America/Phoenix")).toBe("Oct 30, 2026, 8:00 PM MST");
  });
  it("can include seconds", () => {
    expect(formatDateTime(new Date("2026-10-31T03:03:12Z"), "America/New_York", { seconds: true })).toBe(
      "Oct 30, 2026, 11:03:12 PM ET",
    );
  });
  it("follows daylight saving time across the boundary", () => {
    // US clocks fall back at 2:00 AM EDT on Nov 1, 2026 (06:00 UTC).
    expect(formatDateTime(new Date("2026-11-01T05:30:00Z"), "America/New_York")).toBe(
      "Nov 1, 2026, 1:30 AM ET",
    );
    expect(formatDateTime(new Date("2026-11-01T06:30:00Z"), "America/New_York")).toBe(
      "Nov 1, 2026, 1:30 AM ET",
    );
    expect(formatDateTime(new Date("2026-11-01T07:30:00Z"), "America/New_York")).toBe(
      "Nov 1, 2026, 2:30 AM ET",
    );
  });
  it("shows midnight and noon as 12", () => {
    expect(formatDateTime(new Date("2026-07-01T04:00:00Z"), "America/New_York")).toBe(
      "Jul 1, 2026, 12:00 AM ET",
    );
    expect(formatDateTime(new Date("2026-07-01T16:00:00Z"), "America/New_York")).toBe(
      "Jul 1, 2026, 12:00 PM ET",
    );
  });
  it("falls back to the default zone for an unknown zone and rejects invalid dates", () => {
    expect(formatDateTime(t, "Not/AZone")).toBe(formatDateTime(t, DEFAULT_TIME_ZONE));
    expect(formatDateTime(t, undefined)).toBe("Oct 30, 2026, 11:00 PM ET");
    expect(() => formatDateTime(new Date("nope"), "America/New_York")).toThrow();
  });
});

describe("formatDateTime outside the US", () => {
  const t = new Date("2026-10-31T03:00:00Z");
  it("uses the zone's short name or its GMT offset", () => {
    // London is on GMT after Oct 25, 2026; on summer time it shows its offset.
    expect(formatDateTime(t, "Europe/London")).toBe("Oct 31, 2026, 3:00 AM GMT");
    expect(formatDateTime(new Date("2026-07-01T12:00:00Z"), "Europe/London")).toBe(
      "Jul 1, 2026, 1:00 PM GMT+1",
    );
    // India is five and a half hours ahead, with no daylight saving time.
    expect(formatDateTime(t, "Asia/Kolkata")).toBe("Oct 31, 2026, 8:30 AM GMT+5:30");
    expect(formatDateTime(t, "Asia/Kathmandu")).toBe("Oct 31, 2026, 8:45 AM GMT+5:45");
    expect(formatDateTime(t, "Asia/Tokyo")).toBe("Oct 31, 2026, 12:00 PM GMT+9");
    expect(formatDateTime(t, "UTC")).toMatch(/^Oct 31, 2026, 3:00 AM (UTC|GMT)$/);
    expect(formatDateTime(new Date("2026-10-31T03:03:12Z"), "Asia/Kolkata", { seconds: true })).toBe(
      "Oct 31, 2026, 8:33:12 AM GMT+5:30",
    );
  });
  it("never shows a long generic name", () => {
    for (const z of ["Europe/Berlin", "Australia/Sydney", "America/Sao_Paulo", "Africa/Lagos"])
      expect(formatDateTime(t, z)).toMatch(/ (?:[A-Z]{2,5}|GMT[+-]\d{1,2}(?::\d{2})?)$/);
  });
  it("gives the calendar day in a half-hour zone", () => {
    // 7:00 PM UTC on Oct 30 is 12:30 AM on Oct 31 in India.
    expect(dayInZone(new Date("2026-10-30T19:00:00Z"), "Asia/Kolkata")).toBe("2026-10-31");
    expect(dayInZone(new Date("2026-10-30T18:00:00Z"), "Asia/Kolkata")).toBe("2026-10-30");
  });
});

describe("choosing a time zone", () => {
  it("accepts any IANA zone the runtime supports, by its current name", () => {
    for (const z of ["Europe/London", "Asia/Kolkata", "Asia/Tokyo", "Australia/Sydney", "UTC"])
      expect(isPracticeTimeZone(z)).toBe(true);
    for (const z of PRACTICE_TIME_ZONES) expect(isPracticeTimeZone(z.value)).toBe(true);
    for (const z of ["Mars/Olympus", "", "europe/london", "GMT+5", 5, null])
      expect(isPracticeTimeZone(z)).toBe(false);
    expect(allTimeZones()).toContain("Asia/Kolkata");
    expect(allTimeZones()).not.toContain("Asia/Calcutta");
    expect(allTimeZones().length).toBeGreaterThan(300);
  });
  it("offers the common US zones first, then every other zone grouped by region", () => {
    const groups = timeZoneGroups();
    expect(groups[0]!.label).toBe("Common US zones");
    expect(groups[0]!.options.map((o) => o.value)).toEqual(PRACTICE_TIME_ZONES.map((z) => z.value));
    expect(groups[0]!.options[0]!.label).toBe("Eastern (America/New_York)");
    const labels = groups.map((g) => g.label);
    for (const region of ["America", "Europe", "Asia", "Africa", "Australia", "Pacific"])
      expect(labels).toContain(region);
    const europe = groups.find((g) => g.label === "Europe")!;
    expect(europe.options).toContainEqual({ value: "Europe/London", label: "London (Europe/London)" });
    const america = groups.find((g) => g.label === "America")!;
    // The US zones appear once, in the first group.
    expect(america.options.map((o) => o.value)).not.toContain("America/New_York");
    expect(america.options.find((o) => o.value === "America/Argentina/Buenos_Aires")?.label ?? "").toMatch(
      /^(Buenos Aires, Argentina|)/,
    );
    const all = groups.flatMap((g) => g.options.map((o) => o.value));
    expect(new Set(all).size).toBe(all.length);
    expect(all.sort()).toEqual([...allTimeZones()].sort());
    for (const v of all) expect(isPracticeTimeZone(v)).toBe(true);
  });
});

describe("time zones", () => {
  it("offers only real zones and defaults to Eastern", () => {
    expect(DEFAULT_TIME_ZONE).toBe("America/New_York");
    for (const z of PRACTICE_TIME_ZONES) expect(isTimeZone(z.value)).toBe(true);
    expect(isTimeZone("Not/AZone")).toBe(false);
    expect(isTimeZone("")).toBe(false);
  });
});

describe("dayInZone", () => {
  it("gives the calendar day of an instant in the practice's zone", () => {
    // 8:30 PM Eastern on Oct 30 is 00:30 UTC Oct 31.
    const evening = new Date("2026-10-31T00:30:00Z");
    expect(dayInZone(evening, "America/New_York")).toBe("2026-10-30");
    expect(dayInZone(evening, "Pacific/Honolulu")).toBe("2026-10-30");
    expect(dayInZone(new Date("2026-10-31T05:30:00Z"), "America/New_York")).toBe("2026-10-31");
  });
  it("falls back to Eastern for an unknown zone, and rejects invalid dates", () => {
    expect(dayInZone(new Date("2026-01-01T03:00:00Z"), "Not/AZone")).toBe("2025-12-31");
    expect(dayInZone(new Date("2026-01-01T03:00:00Z"), null)).toBe("2025-12-31");
    expect(() => dayInZone(new Date("nope"), DEFAULT_TIME_ZONE)).toThrow();
  });
});
