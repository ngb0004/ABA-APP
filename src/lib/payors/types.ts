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
] as const;
export type RuleType = (typeof RULE_TYPES)[number];

export const SeedRuleSchema = z.object({
  type: z.enum(RULE_TYPES),
  params: z.record(z.string(), z.unknown()).default({}),
  source: z.string().nullable().optional(),
  section: z.string().optional(),
  verified: z.boolean(),
  notes: z.string().optional(),
});

export const SeedSchema = z.object({
  documents: z.record(
    z.string(),
    z.object({
      name: z.string(),
      version: z.string(),
      url: z.string().nullable(),
      effective_date: z.string().optional(),
    }),
  ),
  payors: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      inherits: z.string().optional(),
      rules: z.array(SeedRuleSchema).default([]),
      extra_rules: z.array(SeedRuleSchema).default([]),
    }),
  ),
  universal_checks: z.array(z.string()).default([]),
});
export type PayorSeed = z.infer<typeof SeedSchema>;

/** A rule as the evaluator sees it (DB row or resolved seed). */
export type Rule = {
  id: string;
  payorKey: string;
  type: RuleType;
  params: Record<string, unknown>;
  verified: boolean;
  source: {
    key: string | null;
    name: string | null;
    version: string | null;
    section: string | null;
    url: string | null;
  };
  notes: string | null;
  inheritedFrom: string | null;
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
