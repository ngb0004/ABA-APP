import type { Day } from "../dates";
import type { ApprovedUnit } from "../utilization";
import type { SupervisionSession } from "../supervision";

/** Everything the evaluator may look at, already loaded and PHI-free. */
export type EvalContext = {
  asOf: Day;
  client: {
    ageYears: number;
    serviceState: string;
    hasIep: boolean;
    hasSecondaryPayor: boolean;
    /** e.g. "bcba_transfer", "insurance_changed_to_umr", "plan_is_aetna_better_health_medicaid" */
    events: string[];
  };
  authorization: { kind: "initial" | "reauth"; startDate: Day; endDate: Day; units: ApprovedUnit[] } | null;
  sessions: (SupervisionSession & { startMinute?: number })[];
  attachments: { kind: string; title: string; documentDate: Day | null }[];
  plan: {
    type: "initial" | "reauth";
    sections: { key: string; state: string; hasContent: boolean }[];
    includesEvaluationDate: boolean;
    allApprovedByBcba: boolean;
  } | null;
  /** Org offices for form_address checks: [{state, address}] */
  offices: { state: string; address: string }[];
  packetSubmitted: boolean;
};
