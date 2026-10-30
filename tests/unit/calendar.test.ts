import { describe, expect, it } from "vitest";
import { authEndAlert, authEvents, caseloadCalendar, DEFAULT_CALENDAR_SETTINGS } from "@/lib/calendar";
import { addMonths } from "@/lib/dates";
import type { Rule } from "@/lib/payors/types";

const rule = (type: Rule["type"], params: Record<string, unknown>): Rule => ({
  id: type,
  payorKey: "p",
  type,
  params,
  verified: false,
  source: { key: null, name: null, version: null, section: null, url: null },
  notes: null,
  inheritedFrom: null,
});

describe("date math", () => {
  it("clamps month arithmetic to month end", () => {
    expect(addMonths("2026-05-31", -3)).toBe("2026-02-28");
    expect(addMonths("2026-01-15", 1)).toBe("2026-02-15");
  });
});

describe("calendar generation", () => {
  const base = {
    clientId: "c",
    authNumber: "SYN-1",
    startDate: "2026-05-01",
    endDate: "2026-10-31",
    kind: "reauth" as const,
  };

  it("generates expiration, submission target, reassessment (30 days before the end), and 30/21/14-day alerts", () => {
    const ev = authEvents({ ...base, rules: [] });
    const by = (k: string) => ev.filter((e) => e.kind === k).map((e) => e.date);
    expect(by("auth_expiration")).toEqual(["2026-10-31"]);
    expect(by("reauth_submission_target")).toEqual(["2026-10-01"]);
    expect(by("reassessment_due")).toEqual(["2026-10-01"]);
    expect(ev.find((e) => e.kind === "reassessment_due")!.label).toBe(
      "Reassessment due (30 days before the authorization ends)",
    );
    // The practice setting moves it.
    const one = authEvents({ ...base, rules: [] }, { ...DEFAULT_CALENDAR_SETTINGS, assessmentDueDays: 1 });
    expect(one.find((e) => e.kind === "reassessment_due")!.date).toBe("2026-10-30");
    expect(DEFAULT_CALENDAR_SETTINGS.assessmentDueDays).toBe(30);
    expect(by("auth_alert")).toEqual(["2026-10-01", "2026-10-10", "2026-10-17"]);
  });

  it("applies Amerigroup-style 97151 timing from rule params (3 months before expiry)", () => {
    const ev = authEvents({
      ...base,
      rules: [rule("request_timing", { code: "97151", separate_request: true, months_before_auth_end: 3 })],
    });
    const e = ev.find((x) => x.kind === "assessment_request_due")!;
    expect(e.date).toBe("2026-07-31");
    expect(e.label).toMatch(/97151.*separate/);
  });

  it("applies TRICARE-style window; outcome measures are due with the reassessment, 30 days before the end", () => {
    const ev = authEvents({
      ...base,
      rules: [
        rule("request_timing", {
          submit_up_to_days_before_auth_end: 60,
          report_due_days_after_assessment: 14,
        }),
        rule("outcome_measure_schedule", { every_6_months: ["PDDBI_parent", "PSI or SIPA"] }),
      ],
    });
    expect(ev.find((x) => x.kind === "reauth_window_opens")!.date).toBe("2026-09-01");
    // One date for assessments (BCBA answer #44): the report-days timing no longer moves it.
    const om = ev.find((x) => x.kind === "outcome_measures_due")!;
    expect(om.date).toBe("2026-10-01");
    expect(om.label).toBe(
      "Outcome measures due if they lapse before the next authorization (30 days before the authorization ends): PDDBI parent, PSI or SIPA",
    );
  });

  it("keeps only events within the next 60 days, sorted", () => {
    const ev = caseloadCalendar([{ ...base, rules: [] }], "2026-10-02", 60);
    expect(ev.every((e) => e.date >= "2026-10-02" && e.date <= "2026-12-01")).toBe(true);
    expect(ev.map((e) => e.date)).toEqual([...ev.map((e) => e.date)].sort());
    expect(ev.some((e) => e.kind === "reassessment_due")).toBe(false);
  });
});

describe("auth end alerts", () => {
  it("reports the most urgent threshold reached", () => {
    expect(authEndAlert("2026-10-31", "2026-09-30")).toBeNull();
    expect(authEndAlert("2026-10-31", "2026-10-01")!.level).toBe(30);
    expect(authEndAlert("2026-10-31", "2026-10-10")!.level).toBe(21);
    expect(authEndAlert("2026-10-31", "2026-10-20")!.level).toBe(14);
    expect(authEndAlert("2026-10-31", "2026-11-02")!.level).toBe(0);
  });

  it("words the alert in plain English", () => {
    expect(authEndAlert("2026-10-31", "2026-10-10")!.message).toBe(
      "21 days until authorization ends (21-day alert)",
    );
    expect(authEndAlert("2026-10-31", "2026-10-30")!.message).toBe(
      "1 day until authorization ends (14-day alert)",
    );
    expect(authEndAlert("2026-10-31", "2026-10-31")!.message).toBe("Authorization ends today (14-day alert)");
    expect(authEndAlert("2026-10-31", "2026-11-01")!.message).toBe("Authorization ended 1 day ago");
  });
});
