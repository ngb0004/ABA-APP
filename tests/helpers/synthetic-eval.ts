import { ageYears } from "@/lib/dates";
import type { EvalContext } from "@/lib/payors/context";
import { buildDataset, type SynClient } from "../../seed/synthetic/dataset";

export const AS_OF = "2026-10-29";
export const dataset = buildDataset(AS_OF);
export const sampleOrg = dataset.orgs[0]!;
export const client = (k: SynClient["key"]) => sampleOrg.clients.find((c) => c.key === k)!;

/** In-memory equivalent of services/payors.buildEvalContext for a synthetic client. */
export function evalContextFor(
  c: SynClient,
  plan: EvalContext["plan"] = null,
  overrides: Partial<EvalContext> = {},
): EvalContext {
  return {
    asOf: AS_OF,
    client: {
      ageYears: ageYears(c.dob, AS_OF),
      serviceState: c.serviceAddress.state,
      hasIep: c.hasIep,
      hasSecondaryPayor: c.payors.some((p) => p.priority === "secondary"),
      events: c.events,
    },
    authorization: {
      kind: c.authorization.kind,
      startDate: c.authorization.startDate,
      endDate: c.authorization.endDate,
      units: c.authorization.units,
    },
    sessions: c.sessions.map((s) => ({ ...s })),
    attachments: c.attachments.map((a) => ({ kind: a.kind, title: a.title, documentDate: a.documentDate })),
    plan,
    offices: (sampleOrg.settings.offices as { state: string; address: string }[]) ?? [],
    packetSubmitted: false,
    ...overrides,
  };
}

export const fullPlan = (type: "initial" | "reauth"): EvalContext["plan"] => ({
  type,
  sections: [
    "identifying",
    "background",
    "assessment",
    "behavior",
    "skill_goals",
    "behavior_goals",
    "caregiver",
    "services",
    "coordination",
    "crisis",
    "transition",
  ].map((key) => ({ key, state: "approved", hasContent: true })),
  includesEvaluationDate: true,
  allApprovedByBcba: true,
});
