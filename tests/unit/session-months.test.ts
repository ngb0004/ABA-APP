import { describe, expect, it } from "vitest";
import { isMonth, monthLabel, monthRange, neighbours, pickMonth } from "@/lib/session-months";

const months = [
  { month: "2026-09", sessions: 20, units: 400 },
  { month: "2026-10", sessions: 18, units: 380 },
  { month: "2026-07", sessions: 5, units: 90 },
];

describe("session months", () => {
  it("validates YYYY-MM", () => {
    expect(isMonth("2026-10")).toBe(true);
    for (const bad of ["2026-13", "2026-00", "2026-1", "26-10", "2026-10-01", null, 202610])
      expect(isMonth(bad)).toBe(false);
  });

  it("shows the requested month when it has sessions, else the latest month", () => {
    expect(pickMonth(months, "2026-09")).toBe("2026-09");
    expect(pickMonth(months, "2026-08")).toBe("2026-10");
    expect(pickMonth(months, "nonsense")).toBe("2026-10");
    expect(pickMonth(months, undefined)).toBe("2026-10");
    expect(pickMonth([], "2026-10")).toBeNull();
  });

  it("covers the whole month, across year ends and leap Februaries", () => {
    expect(monthRange("2026-12")).toEqual({
      start: new Date("2026-12-01T00:00:00Z"),
      end: new Date("2027-01-01T00:00:00Z"),
    });
    expect(monthRange("2028-02").end).toEqual(new Date("2028-03-01T00:00:00Z"));
    expect(() => monthRange("2026-13")).toThrow();
  });

  it("labels months in words", () => {
    expect(monthLabel("2026-10")).toBe("October 2026");
    expect(monthLabel("2027-01")).toBe("January 2027");
  });

  it("finds the previous and next months that have sessions, skipping empty ones", () => {
    expect(neighbours(months, "2026-09")).toEqual({ prev: "2026-07", next: "2026-10" });
    expect(neighbours(months, "2026-07")).toEqual({ prev: null, next: "2026-09" });
    expect(neighbours(months, "2026-10")).toEqual({ prev: "2026-09", next: null });
  });
});
