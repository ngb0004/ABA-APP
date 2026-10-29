import { describe, expect, it } from "vitest";
import { approvedPerWeek, approvedTotal, computeUtilization } from "@/lib/utilization";
import { supervisionByMonth } from "@/lib/supervision";

const auth = {
  startDate: "2026-01-05",
  endDate: "2026-02-01",
  units: [
    { cptCode: "97153", approvedUnits: 40, unitBasis: "week" as const },
    { cptCode: "97155", approvedUnits: 52, unitBasis: "month" as const },
    { cptCode: "97151", approvedUnits: 24, unitBasis: "auth" as const },
  ],
};

describe("unit basis conversion", () => {
  it("converts per-month to per-week at 52/12 weeks per month", () => {
    expect(approvedPerWeek(auth.units[1]!, auth.startDate, auth.endDate)).toBeCloseTo(12, 10);
  });
  it("totals a per-week basis over the auth length (4 weeks)", () => {
    expect(approvedTotal(auth.units[0]!, auth.startDate, auth.endDate)).toBe(160);
    expect(approvedTotal(auth.units[2]!, auth.startDate, auth.endDate)).toBe(24);
  });
});

describe("utilization", () => {
  const sessions = [
    // week 1: 40 units (100%)
    ...[0, 1, 2, 3].map((i) => ({ cptCode: "97153", date: `2026-01-0${5 + i}`, units: 10 })),
    // week 2: 30 units (75%) -> under
    ...[0, 1, 2].map((i) => ({ cptCode: "97153", date: `2026-01-${12 + i}`, units: 10 })),
    // week 3: 44 units (110%) -> over
    ...[0, 1, 2, 3].map((i) => ({ cptCode: "97153", date: `2026-01-${19 + i}`, units: 11 })),
    { cptCode: "97151", date: "2026-01-06", units: 30 },
  ];
  const u = computeUtilization(auth, sessions, "2026-01-26");
  const direct = u.find((x) => x.cptCode === "97153")!;

  it("computes weekly delivered vs approved and flags under (<80%) and over (>100%)", () => {
    expect(direct.weeks.map((w) => [w.delivered, w.pct, w.flag])).toEqual([
      [40, 1, null],
      [30, 0.75, "under"],
      [44, 1.1, "over"],
    ]);
  });
  it("only counts complete weeks and prorates expected units to date", () => {
    expect(direct.expectedToDate).toBe(120);
    expect(direct.deliveredToDate).toBe(114);
    expect(direct.pctToDate).toBe(0.95);
    expect(direct.flag).toBeNull();
  });
  it("flags over-delivery on a per-auth code when the total is exceeded", () => {
    expect(u.find((x) => x.cptCode === "97151")!.flag).toBe("over");
  });
  it("ignores sessions outside the authorization", () => {
    const r = computeUtilization(auth, [{ cptCode: "97153", date: "2025-12-31", units: 40 }], "2026-01-12");
    expect(r[0]!.deliveredToDate).toBe(0);
    expect(r[0]!.weeks[0]!.flag).toBe("under");
  });
});

describe("supervision by month", () => {
  it("computes the supervision ratio per complete month and per technician", () => {
    const s = [
      { cptCode: "97153", date: "2026-03-02", units: 160, inPerson: true, providerId: "A" },
      { cptCode: "97153", date: "2026-03-03", units: 80, inPerson: true, providerId: "B" },
      { cptCode: "97155", date: "2026-03-02", units: 16, inPerson: true },
      { cptCode: "97155", date: "2026-03-03", units: 4, inPerson: false },
      { cptCode: "97153", date: "2026-04-01", units: 8, inPerson: true, providerId: "A" },
    ];
    const m = supervisionByMonth(s, { start: "2026-03-01", end: "2026-06-30", asOf: "2026-04-10" });
    expect(m).toHaveLength(1); // April is incomplete
    expect(m[0]!.directHours).toBe(60);
    expect(m[0]!.supervisionHours).toBe(5);
    expect(m[0]!.ratio).toBe(0.083);
    expect(m[0]!.inPersonSupervisionSessions).toBe(1);
    expect(m[0]!.perTechnician).toEqual([
      { providerId: "A", directHours: 40, supervisionHours: 4, ratio: 0.1 },
      { providerId: "B", directHours: 20, supervisionHours: 1, ratio: 0.05 },
    ]);
  });
});
