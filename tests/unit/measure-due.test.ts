import { describe, expect, it } from "vitest";
import {
  currentAuthorization,
  DEFAULT_ASSESSMENT_DUE_DAYS,
  measureDue,
  measureDueLine,
} from "@/lib/payors/measure-due";

// BCBA answer #44: an assessment is due for the coming reauthorization when its cadence would lapse
// before the next authorization starts; it is due by the current authorization's end minus N days.
const auth = (startDate: string, endDate: string) => ({ startDate, endDate });

describe("measure due dates against the current authorization", () => {
  it("defaults to 30 days before the authorization ends", () => {
    expect(DEFAULT_ASSESSMENT_DUE_DAYS).toBe(30);
  });

  it("six-month cadence lapsing before the next authorization: due 30 days before the end", () => {
    const d = measureDue({
      lastGiven: "2026-04-12",
      cadenceMonths: 6,
      authorization: auth("2026-05-12", "2026-11-09"),
      asOf: "2026-09-01",
      daysBefore: 30,
    });
    expect(d).toMatchObject({
      basis: "authorization",
      lapses: "2026-10-12",
      due: true,
      dueBy: "2026-10-10",
      overdue: false,
      authEnd: "2026-11-09",
    });
  });

  it("is overdue only after the due-by date", () => {
    const base = {
      lastGiven: "2026-04-12",
      cadenceMonths: 6,
      authorization: auth("2026-05-12", "2026-11-09"),
      daysBefore: 30,
    };
    expect(measureDue({ ...base, asOf: "2026-10-10" }).overdue).toBe(false);
    expect(measureDue({ ...base, asOf: "2026-10-11" }).overdue).toBe(true);
  });

  it("lapsing on the day the next authorization starts is not due (lapse < end + 1 day)", () => {
    // 2026-05-01 + 6 months = 2026-11-01, the day after the authorization ends.
    const notDue = measureDue({
      lastGiven: "2026-05-01",
      cadenceMonths: 6,
      authorization: auth("2026-05-01", "2026-10-31"),
      asOf: "2026-10-20",
      daysBefore: 30,
    });
    expect(notDue).toMatchObject({ due: false, dueBy: null, overdue: false, lapses: "2026-11-01" });
    // One day earlier lapses on the last day of the authorization: due.
    const due = measureDue({
      lastGiven: "2026-04-30",
      cadenceMonths: 6,
      authorization: auth("2026-05-01", "2026-10-31"),
      asOf: "2026-10-20",
      daysBefore: 30,
    });
    expect(due).toMatchObject({ due: true, dueBy: "2026-10-01", overdue: true, lapses: "2026-10-30" });
  });

  it("authorization ending on the 31st: due by counts back in days", () => {
    const d = measureDue({
      lastGiven: "2026-01-31",
      cadenceMonths: 6,
      authorization: auth("2026-02-01", "2026-07-31"),
      asOf: "2026-05-01",
      daysBefore: 30,
    });
    // 2026-01-31 + 6 months = 2026-07-31 (the last day): due.
    expect(d).toMatchObject({ lapses: "2026-07-31", due: true, dueBy: "2026-07-01" });
    // With 31 days it lands on the 30th of the previous month.
    const in31 = {
      lastGiven: "2026-01-31",
      cadenceMonths: 6,
      authorization: auth("2026-02-01", "2026-07-31"),
      asOf: "2026-05-01",
      daysBefore: 31,
    };
    expect(measureDue(in31).dueBy).toBe("2026-06-30");
  });

  it("month ends clamp: August 31 plus six months is the end of February", () => {
    const d = measureDue({
      lastGiven: "2026-08-31",
      cadenceMonths: 6,
      authorization: auth("2026-09-01", "2027-02-28"),
      asOf: "2026-12-01",
      daysBefore: 30,
    });
    expect(d).toMatchObject({ lapses: "2027-02-28", due: true, dueBy: "2027-01-29" });
  });

  it("leap years: February 29 and due by across a leap day", () => {
    const leap = measureDue({
      lastGiven: "2027-08-31",
      cadenceMonths: 6,
      authorization: auth("2027-09-01", "2028-03-15"),
      asOf: "2027-12-01",
      daysBefore: 30,
    });
    // 2027-08-31 + 6 months = 2028-02-29; 2028-03-15 - 30 days = 2028-02-14.
    expect(leap).toMatchObject({ lapses: "2028-02-29", due: true, dueBy: "2028-02-14" });
    // An annual measure given on a leap day lapses on February 28.
    const annual = measureDue({
      lastGiven: "2028-02-29",
      cadenceMonths: 12,
      authorization: auth("2028-09-01", "2029-02-28"),
      asOf: "2028-12-01",
      daysBefore: 30,
    });
    expect(annual).toMatchObject({ lapses: "2029-02-28", due: true, dueBy: "2029-01-29" });
  });

  it("annual and two-year cadences that outlast the authorization are not due", () => {
    const annual = measureDue({
      lastGiven: "2026-04-12",
      cadenceMonths: 12,
      authorization: auth("2026-05-12", "2026-11-09"),
      asOf: "2026-10-29",
      daysBefore: 30,
    });
    expect(annual).toMatchObject({ due: false, lapses: "2027-04-12", dueBy: null, overdue: false });
    const twoYear = measureDue({
      lastGiven: "2024-11-09",
      cadenceMonths: 24,
      authorization: auth("2026-05-12", "2026-11-09"),
      asOf: "2026-10-29",
      daysBefore: 30,
    });
    // 2024-11-09 + 24 months = 2026-11-09, the last day: due.
    expect(twoYear).toMatchObject({ due: true, lapses: "2026-11-09", dueBy: "2026-10-10", overdue: true });
  });

  it("initial (baseline, six months) uses the same rule", () => {
    const d = measureDue({
      lastGiven: "2026-03-01",
      cadenceMonths: 6,
      authorization: auth("2026-04-01", "2026-09-30"),
      asOf: "2026-06-01",
      daysBefore: 30,
    });
    expect(d).toMatchObject({ due: true, dueBy: "2026-08-31", overdue: false });
  });

  it("never given: due by the same date", () => {
    const d = measureDue({
      lastGiven: null,
      cadenceMonths: 6,
      authorization: auth("2026-05-12", "2026-11-09"),
      asOf: "2026-10-29",
      daysBefore: 30,
    });
    expect(d).toMatchObject({ due: true, lapses: null, dueBy: "2026-10-10", overdue: true });
  });

  it("the setting moves the due-by date", () => {
    const d = measureDue({
      lastGiven: "2026-04-12",
      cadenceMonths: 6,
      authorization: auth("2026-05-12", "2026-11-09"),
      asOf: "2026-09-01",
      daysBefore: 1,
    });
    expect(d.dueBy).toBe("2026-11-08");
  });
});

describe("no current authorization: cadence from the last administration", () => {
  it("due by last given plus the cadence; overdue once it has passed", () => {
    const input = { lastGiven: "2025-10-01", cadenceMonths: 12, authorization: null, daysBefore: 30 };
    expect(measureDue({ ...input, asOf: "2026-10-01" })).toMatchObject({
      basis: "cadence",
      due: false,
      dueBy: "2026-10-01",
      overdue: false,
      authEnd: null,
    });
    expect(measureDue({ ...input, asOf: "2026-10-02" })).toMatchObject({
      due: true,
      overdue: true,
      dueBy: "2026-10-01",
    });
  });

  it("never given: due, with no date", () => {
    expect(
      measureDue({
        lastGiven: null,
        cadenceMonths: 6,
        authorization: null,
        asOf: "2026-10-01",
        daysBefore: 30,
      }),
    ).toMatchObject({ basis: "cadence", due: true, dueBy: null, overdue: false });
  });

  it("an authorization that has ended is not current", () => {
    expect(currentAuthorization(auth("2026-01-01", "2026-06-30"), "2026-07-01")).toBeNull();
    expect(currentAuthorization(auth("2026-01-01", "2026-06-30"), "2026-06-30")).toEqual(
      auth("2026-01-01", "2026-06-30"),
    );
    expect(currentAuthorization(null, "2026-06-30")).toBeNull();
  });
});

describe("due lines", () => {
  const a = auth("2026-05-12", "2026-11-09");
  const line = (
    lastGiven: string | null,
    cadenceMonths: number,
    asOf: string,
    daysBefore = 30,
    au: typeof a | null = a,
  ) =>
    measureDueLine(
      "Vineland-3",
      measureDue({ lastGiven, cadenceMonths, authorization: au, asOf, daysBefore }),
    );

  it("names the date, the days, and the authorization end", () => {
    expect(line("2026-04-12", 6, "2026-09-01")).toBe(
      "Vineland-3 last given 2026-04-12 · due by 2026-10-10 (30 days before the authorization ends 2026-11-09)",
    );
    expect(line("2026-04-12", 6, "2026-10-29")).toBe(
      "Vineland-3 last given 2026-04-12 · overdue since 2026-10-10 (30 days before the authorization ends 2026-11-09)",
    );
    expect(line("2026-04-12", 6, "2026-09-01", 1)).toBe(
      "Vineland-3 last given 2026-04-12 · due by 2026-11-08 (1 day before the authorization ends 2026-11-09)",
    );
    expect(line("2026-04-12", 12, "2026-10-29")).toBe(
      "Vineland-3 last given 2026-04-12 · next due 2027-04-12, after the authorization ends 2026-11-09",
    );
    expect(line(null, 6, "2026-09-01")).toBe(
      "Vineland-3 not given yet · due by 2026-10-10 (30 days before the authorization ends 2026-11-09)",
    );
  });

  it("without a current authorization, the cadence date", () => {
    expect(line("2026-04-12", 12, "2026-10-29", 30, null)).toBe(
      "Vineland-3 last given 2026-04-12 · due by 2027-04-12",
    );
    expect(line("2025-04-12", 12, "2026-10-29", 30, null)).toBe(
      "Vineland-3 last given 2025-04-12 · overdue since 2026-04-12",
    );
    expect(line(null, 12, "2026-10-29", 30, null)).toBeNull();
  });
});
