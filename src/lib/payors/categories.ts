/** Grouping and status of a client's payor requirements. Pure functions, so they are unit tested. */
import type { RuleType } from "./types";

/** Topics a client's requirements are grouped under, in the order shown. */
export const RULE_CATEGORIES: { key: string; label: string; types: RuleType[] }[] = [
  {
    key: "submitting",
    label: "Submitting the request",
    types: ["request_timing", "submission_channel", "decision_timeframe", "form_address"],
  },
  {
    key: "documents",
    label: "Documents and signatures",
    types: ["required_document", "signature_type", "outcome_measure_schedule"],
  },
  { key: "plan", label: "Treatment plan content", types: ["plan_content"] },
  {
    key: "services",
    label: "Hours, units, and billing",
    types: ["unit_limit", "unit_basis", "daily_cap", "concurrent_billing", "min_sessions_per_auth"],
  },
  { key: "staff", label: "Staff and supervision", types: ["staff_credential", "supervision_ratio"] },
  { key: "events", label: "Changes and events", types: ["event_trigger"] },
];

/** The topic a rule type is shown under ("other" for a type no topic lists). */
export function ruleCategory(type: string): string {
  return RULE_CATEGORIES.find((c) => (c.types as string[]).includes(type))?.key ?? "other";
}

export type RequirementStatus = "met" | "missing" | "manual" | "n/a";
/**
 * Where a rule stands for this client, from the evaluator's raw result (before an unverified rule
 * is softened to a warning, so a missing item still reads "missing" next to its unverified badge).
 */
export function requirementStatus(rawStatus: string): RequirementStatus {
  if (rawStatus === "pass") return "met";
  if (rawStatus === "fail") return "missing";
  if (rawStatus === "n/a") return "n/a";
  return "manual";
}
