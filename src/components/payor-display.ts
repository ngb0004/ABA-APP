/** Display helpers for the payor rules screens. Pure functions, so they are unit tested. */
import type { RequirementStatus } from "@/lib/payors/categories";
import type { RuleType } from "@/lib/payors/types";

/** Revoke only on OK. window.prompt returns null on Cancel, which must not revoke. */
export function revokeNoteFromPrompt(
  answer: string | null,
): { revoke: false } | { revoke: true; note: string | null } {
  if (answer === null) return { revoke: false };
  return { revoke: true, note: answer.trim() || null };
}

const IDENTIFIER = /^[a-z0-9]+(_[a-z0-9]+)+$/i;

/** "max_age_months" -> "Max age months". */
export function humanizeKey(key: string): string {
  const s = key.replace(/_/g, " ").trim();
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function humanizeValue(v: unknown): string {
  if (v === null || v === undefined) return "-";
  if (typeof v === "boolean") return v ? "yes" : "no";
  if (typeof v === "string") return IDENTIFIER.test(v) ? v.replace(/_/g, " ") : v;
  if (typeof v === "number") return String(v);
  if (Array.isArray(v)) return v.map(humanizeValue).join(", ");
  if (typeof v === "object")
    return Object.entries(v as Record<string, unknown>)
      .map(([k, x]) => `${humanizeKey(k).toLowerCase()}: ${humanizeValue(x)}`)
      .join("; ");
  return String(v);
}

/** A rule's parameters as readable label/value pairs, in their stored order. */
export function paramEntries(params: Record<string, unknown> | null | undefined): [string, string][] {
  return Object.entries(params ?? {}).map(([k, v]) => [humanizeKey(k), humanizeValue(v)]);
}

/** "1 rule", "2 rules". */
export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** One-line result of "Check sources now", e.g. "Checked 13 sources: no new versions; 1 could not be reached." */
export function summarizeChecks(
  checks: { name: string; health: string; newVersion: boolean; error: string | null }[],
): string {
  if (!checks.length) return "No sources have a public link to check.";
  const fresh = checks.filter((c) => c.newVersion);
  const broken = checks.filter((c) => c.health === "broken");
  const parts = [
    fresh.length
      ? `${plural(fresh.length, "new version")} (${fresh.map((c) => c.name).join(", ")})`
      : "no new versions",
  ];
  if (broken.length)
    parts.push(`${broken.length} could not be reached (${broken.map((c) => c.name).join(", ")})`);
  return `Checked ${plural(checks.length, "source")}: ${parts.join("; ")}.`;
}

/** What the evidence tiers mean (docs/PAYOR_RULES_STRATEGY.md). */
export const TIER_LEGEND: [string, string][] = [
  ["T1", "the current official payor document"],
  ["T2", "written payor correspondence with a named responder or reference number"],
  ["T3", "a payor portal chat transcript"],
  ["T4", "a phone answer with a reference number"],
  ["T5", "a secondary source such as a practice checklist; never enough to verify a rule"],
];

/** What the trust statuses mean. */
export const STATUS_LEGEND: [string, string, string][] = [
  [
    "verified",
    "verified",
    "Yoma's reviewers confirmed the rule against a sentence in the current official document.",
  ],
  [
    "stale",
    "needs re-check",
    "The document changed, broke, or reached its next scheduled revision since it was verified. Warnings only until Yoma's reviewers re-check it.",
  ],
  [
    "unverified",
    "unverified",
    "Yoma's reviewers have not yet confirmed the rule against the current document. Warnings only.",
  ],
  ["unsourced", "no source", "No document is recorded for this rule. Warnings only."],
];

/** Rule types in plain words, for people who do not read policy manuals. */
export const RULE_TYPE_LABELS: Record<RuleType, string> = {
  required_document: "A document the request must include",
  signature_type: "How documents must be signed",
  form_address: "Address the request form must show",
  supervision_ratio: "Minimum BCBA supervision",
  daily_cap: "Most hours or units in one day",
  concurrent_billing: "Codes that can (or cannot) be billed at the same time",
  min_sessions_per_auth: "Fewest sessions per authorization",
  unit_limit: "Most units approved",
  unit_basis: "How units are counted",
  request_timing: "When to submit the request",
  outcome_measure_schedule: "Outcome measures and when they are due",
  staff_credential: "Who may deliver the service",
  event_trigger: "Something that must happen after an event",
  plan_content: "What the treatment plan must cover",
  submission_channel: "Where and how to submit",
  decision_timeframe: "How long the payor takes to decide",
};

export const REQUIREMENT_STATUS_LABELS: Record<RequirementStatus, string> = {
  met: "met",
  missing: "missing",
  manual: "manual check",
  "n/a": "not applicable",
};
