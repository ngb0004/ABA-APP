import type { Day } from "../dates";
import type { ApprovedUnit } from "../utilization";
import type { SupervisionSession } from "../supervision";
import type { PlanType } from "./types";

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
    /** The primary plan's type (fully insured vs self-funded decides whether state mandates apply). */
    planType: PlanType;
    /** State the primary plan was issued in; null means the service state. */
    planState: string | null;
  };
  /** The primary payor's scope: the states its rules apply in (empty = every state). */
  payor: { key: string; name: string; states: string[]; lineOfBusiness: string } | null;
  authorization: { kind: "initial" | "reauth"; startDate: Day; endDate: Day; units: ApprovedUnit[] } | null;
  sessions: (SupervisionSession & { startMinute?: number })[];
  attachments: { kind: string; title: string; documentDate: Day | null }[];
  /**
   * Confirmed assessments and verified VB-MAPP administrations: catalog type, form, the BCBA's
   * name for an "other" assessment, the date given, and a display name. No scores, no notes.
   */
  assessments: {
    typeKey: string;
    form: string | null;
    customName: string | null;
    administeredOn: Day;
    name: string;
  }[];
  plan: {
    type: "initial" | "reauth";
    sections: { key: string; state: string; hasContent: boolean }[];
    includesEvaluationDate: boolean;
    allApprovedByBcba: boolean;
    /** Every goal has data points, so the packet carries a progress graph for each. */
    goalsHaveData?: boolean;
  } | null;
  /** Org offices for form_address checks: [{state, address}] */
  offices: { state: string; address: string }[];
  packetSubmitted: boolean;
  /**
   * Practice setting: assessments (outcome measures, reassessment) are due this many days before
   * the authorization ends. Defaults to 30 (BCBA answer, QUESTIONS #44).
   */
  assessmentDueDays?: number;
};
