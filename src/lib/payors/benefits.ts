/**
 * Benefits checks (verification of benefits, VOB): what a payor said about one client's coverage,
 * from its portal, a phone call, or an electronic eligibility response. BCBAs learn most payor
 * requirements this way, so the check is recorded per insurance and kept as history.
 *
 * Pure helpers, unit tested: the plan-type update rule and the pre-submission findings.
 */
import { toDay, type Day } from "../dates";
import type { PlanType } from "./types";

export const BENEFITS_CHECK_METHODS = ["portal", "phone", "electronic_eligibility", "other"] as const;
export type BenefitsCheckMethod = (typeof BENEFITS_CHECK_METHODS)[number];
export const METHOD_LABELS: Record<BenefitsCheckMethod, string> = {
  portal: "payor portal",
  phone: "phone call",
  electronic_eligibility: "electronic eligibility",
  other: "other",
};

export const YES_NO_UNKNOWN = ["yes", "no", "unknown"] as const;
export type YesNoUnknown = (typeof YES_NO_UNKNOWN)[number];

/** Fully insured plans must follow state autism mandates; self-funded employer (ERISA) plans are exempt. */
export const PLAN_FUNDING = ["fully_insured", "self_funded", "unknown"] as const;
export type PlanFunding = (typeof PLAN_FUNDING)[number];
export const PLAN_FUNDING_LABELS: Record<PlanFunding, string> = {
  fully_insured: "Fully insured",
  self_funded: "Self-funded employer (ERISA)",
  unknown: "Not known",
};

/**
 * The plan type a benefits check confirms, or null to leave the insurance as it is. Only an
 * unconfirmed commercial plan changes: "commercial_unknown", or "unknown" on a commercial payor.
 * A confirmed plan type (Medicaid, TRICARE, or commercial already confirmed) is never overwritten.
 */
export function planTypeFromFunding(
  current: PlanType,
  payorLineOfBusiness: string,
  funding: PlanFunding,
): PlanType | null {
  if (funding === "unknown") return null;
  const unconfirmedCommercial =
    current === "commercial_unknown" || (current === "unknown" && payorLineOfBusiness === "commercial");
  if (!unconfirmedCommercial) return null;
  return funding === "fully_insured" ? "commercial_fully_insured" : "commercial_self_funded";
}

/** A confirmed commercial plan type that the check's funding answer contradicts. */
export function fundingContradicts(planType: PlanType, funding: PlanFunding): boolean {
  return (
    (planType === "commercial_fully_insured" && funding === "self_funded") ||
    (planType === "commercial_self_funded" && funding === "fully_insured")
  );
}

/** The fields the findings look at. */
export type CheckLike = {
  payorId: string;
  checkedOn: Date | Day;
  createdAt?: Date;
  method: string;
  abaCovered: string;
  priorAuthRequired: string;
};

const dayOf = (d: Date | Day) => (typeof d === "string" ? d : toDay(d));

/** Newest first: by the date checked, then by when it was recorded. */
export function latestCheck<T extends CheckLike>(checks: T[], payorId: string): T | null {
  return (
    checks
      .filter((c) => c.payorId === payorId)
      .sort(
        (a, b) =>
          dayOf(b.checkedOn).localeCompare(dayOf(a.checkedOn)) ||
          (b.createdAt?.getTime() ?? 0) - (a.createdAt?.getTime() ?? 0),
      )[0] ?? null
  );
}

export type BenefitsFinding = { id: string; message: string; details: string[] };

/**
 * Pre-submission findings about the benefits check for the authorization's payor. Warnings only:
 * a benefits check is the practice's own record, never a payor rule, so it never blocks export.
 */
export function benefitsFindings(
  checks: CheckLike[],
  auth: { payorId: string; payorName: string; startDate: Date | Day } | null,
): BenefitsFinding[] {
  if (!auth) return [];
  const start = dayOf(auth.startDate);
  const latest = latestCheck(checks, auth.payorId);
  const out: BenefitsFinding[] = [];
  const last = latest
    ? `Last benefits check: ${dayOf(latest.checkedOn)} (${METHOD_LABELS[latest.method as BenefitsCheckMethod] ?? latest.method})`
    : "No benefits check on record for this payor";
  if (!latest || dayOf(latest.checkedOn) < start)
    out.push({
      id: "benefits.not_checked",
      message: `No benefits check recorded for ${auth.payorName} since the authorization started (${start})`,
      details: [last, "Coverage and prior authorization rules can change at a plan year or employer change"],
    });
  if (latest?.abaCovered === "no")
    out.push({
      id: "benefits.not_covered",
      message: `The latest benefits check says ${auth.payorName} does not cover ABA for this plan`,
      details: [last, "Confirm coverage (or an exception) before submitting"],
    });
  if (latest?.priorAuthRequired === "unknown")
    out.push({
      id: "benefits.prior_auth_unknown",
      message: `The latest benefits check does not say whether ${auth.payorName} requires prior authorization`,
      details: [last],
    });
  return out;
}
