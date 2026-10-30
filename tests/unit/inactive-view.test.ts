import { describe, expect, it } from "vitest";
import {
  historicalAsOf,
  historicalRuleResults,
  historicalUtilization,
  inactiveRuleMessage,
} from "@/lib/inactive-view";
import { computeUtilization } from "@/lib/utilization";
import type { RuleResult } from "@/lib/payors/types";

const rule = { id: "r1", type: "outcome_measure_schedule", verified: true } as unknown as RuleResult["rule"];
const result = (over: Partial<RuleResult>): RuleResult => ({
  rule,
  status: "fail",
  rawStatus: "fail",
  message: "Outcome measures due: Vineland-3",
  evidence: ["Vineland-3: assessment (2025-01-02), due annually"],
  schedule: ["Vineland-3 last given 2025-01-02: overdue since 2026-01-02"],
  ...over,
});

describe("as-of date for an inactive client", () => {
  it("is the inactive date when that is earlier than today", () => {
    expect(historicalAsOf("2026-10-30", new Date("2026-09-01T00:00:00Z"))).toBe("2026-09-01");
  });
  it("is today when the inactive date is later (one day of time-zone tolerance) or missing", () => {
    expect(historicalAsOf("2026-10-30", new Date("2026-10-31T00:00:00Z"))).toBe("2026-10-30");
    expect(historicalAsOf("2026-10-30", null)).toBe("2026-10-30");
  });
});

describe("payor rule results for an inactive client", () => {
  it("turns fail and warn into n/a, drops the due-date lines, and says why", () => {
    const [fail, warn, pass, na] = historicalRuleResults(
      [
        result({}),
        result({ status: "warn", rawStatus: "fail", message: "Request timing: due 2026-09-15" }),
        result({ status: "pass", rawStatus: "pass", message: "Request timing: next due 2027-01-01" }),
        result({ status: "n/a", rawStatus: "n/a", message: "No outcome measures due", schedule: undefined }),
      ],
      "2026-09-01",
    );
    for (const r of [fail!, warn!, pass!]) {
      expect(r.status).toBe("n/a");
      expect(r.rawStatus).toBe("n/a");
      expect(r.schedule).toBeUndefined();
      expect(r.message).toBe(inactiveRuleMessage("2026-09-01"));
      expect(r.message).not.toMatch(/overdue|due by|next due/);
    }
    expect(fail!.evidence).toEqual(result({}).evidence);
    expect(na!.message).toBe("No outcome measures due");
  });
});

describe("utilization for an inactive client", () => {
  it("keeps the figures as of the inactive date and clears every flag", () => {
    const rows = computeUtilization(
      {
        startDate: "2026-01-05",
        endDate: "2026-06-28",
        units: [{ cptCode: "97153", approvedUnits: 40, unitBasis: "week" }],
      },
      [{ cptCode: "97153", date: "2026-01-06", units: 4 }],
      "2026-03-01",
    );
    expect(rows[0]!.flag).toBe("under");
    expect(rows[0]!.weeks.some((w) => w.flag)).toBe(true);
    const [h] = historicalUtilization(rows);
    expect(h!.flag).toBeNull();
    expect(h!.weeks.every((w) => w.flag === null)).toBe(true);
    expect(h!.deliveredToDate).toBe(rows[0]!.deliveredToDate);
    expect(h!.expectedToDate).toBe(rows[0]!.expectedToDate);
  });
});
