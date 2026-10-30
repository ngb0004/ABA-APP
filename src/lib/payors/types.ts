import { z } from "zod";

export const RULE_TYPES = [
  "required_document",
  "signature_type",
  "form_address",
  "supervision_ratio",
  "daily_cap",
  "concurrent_billing",
  "min_sessions_per_auth",
  "unit_limit",
  "unit_basis",
  "request_timing",
  "outcome_measure_schedule",
  "staff_credential",
  "event_trigger",
  "plan_content",
  "submission_channel",
  "decision_timeframe",
] as const;
export type RuleType = (typeof RULE_TYPES)[number];

/** USPS codes for the states, DC, and the territories a payor or plan can be scoped to. */
// prettier-ignore
export const US_STATES = [
  "AL", "AK", "AZ", "AR", "CA", "CO", "CT", "DE", "DC", "FL", "GA", "HI", "ID", "IL", "IN", "IA", "KS",
  "KY", "LA", "ME", "MD", "MA", "MI", "MN", "MS", "MO", "MT", "NE", "NV", "NH", "NJ", "NM", "NY", "NC",
  "ND", "OH", "OK", "OR", "PA", "RI", "SC", "SD", "TN", "TX", "UT", "VT", "VA", "WA", "WV", "WI", "WY",
  "PR", "GU", "VI", "AS", "MP",
] as const;
export type UsState = (typeof US_STATES)[number];

// prettier-ignore
export const STATE_NAMES: Record<UsState, string> = {
  AL: "Alabama", AK: "Alaska", AZ: "Arizona", AR: "Arkansas", CA: "California", CO: "Colorado",
  CT: "Connecticut", DE: "Delaware", DC: "District of Columbia", FL: "Florida", GA: "Georgia",
  HI: "Hawaii", ID: "Idaho", IL: "Illinois", IN: "Indiana", IA: "Iowa", KS: "Kansas", KY: "Kentucky",
  LA: "Louisiana", ME: "Maine", MD: "Maryland", MA: "Massachusetts", MI: "Michigan", MN: "Minnesota",
  MS: "Mississippi", MO: "Missouri", MT: "Montana", NE: "Nebraska", NV: "Nevada", NH: "New Hampshire",
  NJ: "New Jersey", NM: "New Mexico", NY: "New York", NC: "North Carolina", ND: "North Dakota",
  OH: "Ohio", OK: "Oklahoma", OR: "Oregon", PA: "Pennsylvania", RI: "Rhode Island",
  SC: "South Carolina", SD: "South Dakota", TN: "Tennessee", TX: "Texas", UT: "Utah", VT: "Vermont",
  VA: "Virginia", WA: "Washington", WV: "West Virginia", WI: "Wisconsin", WY: "Wyoming",
  PR: "Puerto Rico", GU: "Guam", VI: "U.S. Virgin Islands", AS: "American Samoa",
  MP: "Northern Mariana Islands",
};

/**
 * What kind of coverage a payor offers. Medicaid is run by each state (directly, or through
 * managed care organizations); TRICARE is federal; commercial covers employer and individual plans.
 */
export const LINES_OF_BUSINESS = [
  "medicaid",
  "medicaid_managed_care",
  "commercial",
  "tricare",
  "other",
] as const;
export type LineOfBusiness = (typeof LINES_OF_BUSINESS)[number];
export const LINE_OF_BUSINESS_LABELS: Record<LineOfBusiness, string> = {
  medicaid: "Medicaid",
  medicaid_managed_care: "Medicaid managed care",
  commercial: "Commercial",
  tricare: "TRICARE",
  other: "Other",
};

/**
 * A client's plan type. State autism mandates bind fully insured commercial plans only;
 * self-funded employer (ERISA) plans are exempt. "commercial_unknown" means commercial, but
 * nobody has confirmed which.
 */
export const PLAN_TYPES = [
  "medicaid",
  "medicaid_managed_care",
  "commercial_fully_insured",
  "commercial_self_funded",
  "commercial_unknown",
  "tricare",
  "unknown",
] as const;
export type PlanType = (typeof PLAN_TYPES)[number];

/** Plan types a rule can be limited to: the ones a plan can actually be. */
export const RULE_PLAN_TYPES = [
  "medicaid",
  "medicaid_managed_care",
  "commercial_fully_insured",
  "commercial_self_funded",
  "tricare",
] as const satisfies readonly PlanType[];
export type RulePlanType = (typeof RULE_PLAN_TYPES)[number];

export const PLAN_TYPE_LABELS: Record<PlanType, string> = {
  medicaid: "Medicaid (state)",
  medicaid_managed_care: "Medicaid managed care (CMO)",
  commercial_fully_insured: "Commercial, fully insured",
  commercial_self_funded: "Commercial, self-funded employer (ERISA)",
  commercial_unknown: "Commercial, funding not confirmed",
  tricare: "TRICARE",
  unknown: "Not recorded",
};

/** Plan types an unconfirmed plan type could turn out to be. */
export function possiblePlanTypes(t: PlanType): readonly RulePlanType[] {
  if (t === "unknown") return RULE_PLAN_TYPES;
  if (t === "commercial_unknown") return ["commercial_fully_insured", "commercial_self_funded"];
  return [t];
}

export const SeedRuleSchema = z.object({
  type: z.enum(RULE_TYPES),
  params: z.record(z.string(), z.unknown()).default({}),
  source: z.string().nullable().optional(),
  section: z.string().optional(),
  /** Page in the official document where the rule was read. */
  page: z.union([z.number().int().positive(), z.string()]).optional(),
  /** The official sentence the rule was read from. Pre-fills the verify form; never trusted on its own. */
  quote: z.string().optional(),
  /** Kept for the seed format. The app ignores it: a rule's status comes from recorded evidence. */
  verified: z.boolean(),
  notes: z.string().optional(),
  /**
   * Only for these plan types, when the source says so (e.g., a state mandate that binds fully
   * insured plans only). Scope, not content: it is not part of the rule's fingerprint.
   */
  plan_types: z.array(z.enum(RULE_PLAN_TYPES)).min(1).optional(),
});

export const LocatorSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("direct"), url: z.string().url() }),
  /** Georgia MMIS publication index: find the current file by its title. */
  z.object({ kind: z.literal("ga_mmis_index"), indexUrl: z.string().url(), title: z.string().min(3) }),
]);
export type Locator = z.infer<typeof LocatorSchema>;

export const SeedSchema = z.object({
  documents: z
    .record(
      z.string(),
      z.object({
        name: z.string(),
        version: z.string(),
        url: z.string().nullable(),
        effective_date: z.string().optional(),
        /** How to find the current version; defaults to the url. */
        locator: LocatorSchema.optional(),
        secondary: z.boolean().optional(),
        /**
         * Earlier keys for this document: sync renames the stored row (keeping its fetched
         * copies) and carries its rules' evidence over to their new lineage.
         */
        formerly: z.array(z.string()).optional(),
      }),
    )
    .superRefine((docs, ctx) => {
      const claimed = new Map<string, string>();
      for (const [key, d] of Object.entries(docs))
        for (const old of d.formerly ?? []) {
          if (old in docs)
            ctx.addIssue({ code: "custom", message: `${key}: formerly "${old}" is still a document key` });
          if (claimed.has(old))
            ctx.addIssue({
              code: "custom",
              message: `"${old}" is listed as formerly by ${claimed.get(old)} and ${key}`,
            });
          claimed.set(old, key);
        }
    }),
  payors: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      inherits: z.string().optional(),
      /** States the payor's rules apply in (USPS codes); empty means every state (TRICARE, national policies). */
      states: z
        .array(z.enum(US_STATES))
        .default([])
        .refine((s) => new Set(s).size === s.length, "states: listed twice"),
      line_of_business: z.enum(LINES_OF_BUSINESS),
      rules: z.array(SeedRuleSchema).default([]),
      extra_rules: z.array(SeedRuleSchema).default([]),
    }),
  ),
  universal_checks: z.array(z.string()).default([]),
});
export type PayorSeed = z.infer<typeof SeedSchema>;

/**
 * Trust status, computed from evidence and source health (see src/lib/rules-watch/status.ts):
 * verified, unverified (official source not yet checked, or secondary source only),
 * stale (the source changed, broke, or the verification expired), unsourced.
 */
export type TrustStatus = "verified" | "unverified" | "stale" | "unsourced";

/** A rule as the evaluator sees it (DB row or resolved seed). */
export type Rule = {
  id: string;
  payorKey: string;
  /** Shared by a rule and the copies other payors inherit. */
  lineageKey?: string;
  type: RuleType;
  params: Record<string, unknown>;
  /** True only when the computed trust status is "verified". */
  verified: boolean;
  trust?: {
    status: TrustStatus;
    tier: string | null;
    reasons: string[];
    verifiedUntil: string | null;
    verifiedAt: string | null;
  };
  source: {
    key: string | null;
    name: string | null;
    version: string | null;
    section: string | null;
    url: string | null;
    page?: string | null;
    quote?: string | null;
  };
  notes: string | null;
  inheritedFrom: string | null;
  /** Plan types the rule is limited to; empty or absent means every plan type. */
  planTypes?: string[];
};

export type RuleStatus = "pass" | "fail" | "warn" | "n/a";
export type RuleResult = {
  rule: Rule;
  status: RuleStatus;
  /** What the evaluator would have returned if the rule were verified. */
  rawStatus: RuleStatus;
  message: string;
  evidence: string[];
};

/** A finding about the payor choice itself (wrong state, plan type unknown). Always a warning. */
export type ScopeFinding = { id: string; status: "warn"; message: string; evidence: string[] };
