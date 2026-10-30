import { describe, expect, it } from "vitest";
import {
  DEFAULT_TIME_ZONE,
  PRACTICE_TIME_ZONES,
  formatClock,
  formatDateTime,
  isTimeZone,
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

describe("time zones", () => {
  it("offers only real zones and defaults to Eastern", () => {
    expect(DEFAULT_TIME_ZONE).toBe("America/New_York");
    for (const z of PRACTICE_TIME_ZONES) expect(isTimeZone(z.value)).toBe(true);
    expect(isTimeZone("Not/AZone")).toBe(false);
    expect(isTimeZone("")).toBe(false);
  });
});
