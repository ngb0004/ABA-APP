import { describe, expect, it } from "vitest";
import {
  benefitsFindings,
  fundingContradicts,
  latestCheck,
  planTypeFromFunding,
  type CheckLike,
} from "@/lib/payors/benefits";
import { PLAN_TYPES } from "@/lib/payors/types";

describe("planTypeFromFunding", () => {
  it("confirms an unconfirmed commercial plan", () => {
    expect(planTypeFromFunding("commercial_unknown", "commercial", "fully_insured")).toBe(
      "commercial_fully_insured",
    );
    expect(planTypeFromFunding("commercial_unknown", "other", "self_funded")).toBe("commercial_self_funded");
    expect(planTypeFromFunding("unknown", "commercial", "self_funded")).toBe("commercial_self_funded");
  });

  it("never overwrites Medicaid, TRICARE, or a confirmed plan type", () => {
    for (const t of PLAN_TYPES.filter((x) => x !== "unknown" && x !== "commercial_unknown"))
      for (const f of ["fully_insured", "self_funded"] as const)
        expect(planTypeFromFunding(t, "commercial", f)).toBeNull();
  });

  it("leaves a plan type not recorded alone unless the payor is commercial", () => {
    for (const lob of ["medicaid", "medicaid_managed_care", "tricare", "other"])
      expect(planTypeFromFunding("unknown", lob, "fully_insured")).toBeNull();
  });

  it("does nothing when the funding is not known", () => {
    expect(planTypeFromFunding("commercial_unknown", "commercial", "unknown")).toBeNull();
  });

  it("flags a funding answer that contradicts a confirmed commercial plan type", () => {
    expect(fundingContradicts("commercial_fully_insured", "self_funded")).toBe(true);
    expect(fundingContradicts("commercial_self_funded", "fully_insured")).toBe(true);
    expect(fundingContradicts("commercial_self_funded", "self_funded")).toBe(false);
    expect(fundingContradicts("medicaid", "self_funded")).toBe(false);
    expect(fundingContradicts("commercial_unknown", "unknown")).toBe(false);
  });
});

const check = (over: Partial<CheckLike> = {}): CheckLike => ({
  payorId: "p1",
  checkedOn: "2026-09-10",
  method: "phone",
  abaCovered: "yes",
  priorAuthRequired: "yes",
  ...over,
});
const auth = { payorId: "p1", payorName: "Example Health", startDate: "2026-09-01" };
const ids = (f: ReturnType<typeof benefitsFindings>) => f.map((x) => x.id);

describe("latestCheck", () => {
  it("picks the newest check for the payor, by date then by when it was recorded", () => {
    const a = check({ checkedOn: "2026-09-10", createdAt: new Date("2026-09-10T10:00:00Z") });
    const b = check({ checkedOn: "2026-09-10", createdAt: new Date("2026-09-10T12:00:00Z") });
    const older = check({ checkedOn: "2026-08-01" });
    const otherPayor = check({ payorId: "p2", checkedOn: "2026-10-01" });
    expect(latestCheck([older, a, otherPayor, b], "p1")).toBe(b);
    expect(latestCheck([otherPayor], "p1")).toBeNull();
  });
});

describe("benefitsFindings", () => {
  it("is quiet for a check since the authorization started that covers ABA and answers prior auth", () => {
    expect(benefitsFindings([check()], auth)).toEqual([]);
    expect(benefitsFindings([check({ checkedOn: "2026-09-01", priorAuthRequired: "no" })], auth)).toEqual([]);
  });

  it("warns when no check is recorded, or only one from before the authorization started", () => {
    expect(ids(benefitsFindings([], auth))).toEqual(["benefits.not_checked"]);
    expect(ids(benefitsFindings([check({ checkedOn: "2026-08-31" })], auth))).toEqual([
      "benefits.not_checked",
    ]);
    // A check with a different payor does not count.
    expect(ids(benefitsFindings([check({ payorId: "p2" })], auth))).toEqual(["benefits.not_checked"]);
  });

  it("warns when the latest check says ABA is not covered or prior auth is unknown", () => {
    expect(ids(benefitsFindings([check({ abaCovered: "no" })], auth))).toEqual(["benefits.not_covered"]);
    expect(ids(benefitsFindings([check({ priorAuthRequired: "unknown" })], auth))).toEqual([
      "benefits.prior_auth_unknown",
    ]);
    // Only the latest check counts: a newer "covered" answer clears an older "not covered".
    expect(benefitsFindings([check({ abaCovered: "no", checkedOn: "2026-09-05" }), check()], auth)).toEqual(
      [],
    );
  });

  it("says nothing without an authorization", () => {
    expect(benefitsFindings([], null)).toEqual([]);
  });
});
