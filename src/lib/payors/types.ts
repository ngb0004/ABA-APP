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
         * Earlier keys for this document, oldest first: sync renames the stored row (keeping its
         * fetched copies), and rules keep the lineage they had under the oldest key.
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
