import type { Tx } from "../db";
import { ageYears, toDay, type Day } from "../dates";
import type { EvalContext } from "../payors/context";
import { evaluateRules } from "../payors/evaluate";
import type { Rule, RuleType } from "../payors/types";
import type { UnitBasis } from "../utilization";

export async function loadRules(tx: Tx, payorId: string): Promise<Rule[]> {
  const rows = await tx.payorRule.findMany({
    where: { payorId },
    include: { payor: true, sourceDocument: true },
    orderBy: { ordinal: "asc" },
  });
  return rows.map((r) => ({
    id: r.id,
    payorKey: r.payor.key,
    type: r.type as RuleType,
    params: r.params as Record<string, unknown>,
    verified: r.verified,
    source: {
      key: r.sourceDocument?.key ?? null,
      name: r.sourceDocument?.name ?? null,
      version: r.sourceDocument?.version ?? null,
      section: r.sourceSection,
      url: r.sourceDocument?.url ?? null,
    },
    notes: r.notes,
    inheritedFrom: r.inheritedFrom,
  }));
}

/** Builds the evaluator context for a client (and optionally a plan). */
export async function buildEvalContext(
  tx: Tx,
  clientId: string,
  asOf: Day,
  planId?: string | null,
): Promise<{ ctx: EvalContext; payorId: string | null; authorizationId: string | null }> {
  const client = await tx.client.findUniqueOrThrow({
    where: { id: clientId },
    include: {
      payors: true,
      attachments: true,
      authorizations: { include: { units: true }, orderBy: { endDate: "desc" } },
    },
  });
  const org = await tx.org.findUniqueOrThrow({ where: { id: client.orgId } });
  const plan = planId
    ? await tx.plan.findUnique({ where: { id: planId }, include: { sections: true, packet: true } })
    : null;
  const auth = plan?.authorizationId
    ? (client.authorizations.find((a) => a.id === plan.authorizationId) ?? client.authorizations[0])
    : client.authorizations[0];
  const sessions = auth ? await tx.serviceSession.findMany({ where: { authorizationId: auth.id } }) : [];
  const diagnoses = await tx.diagnosis.findMany({ where: { clientId } });
  const primary = client.payors.find((p) => p.priority === "primary") ?? client.payors[0];
  const offices = (org.settings as { offices?: { state: string; address: string }[] }).offices ?? [];
  const ctx: EvalContext = {
    asOf,
    client: {
      ageYears: ageYears(toDay(client.dob), asOf),
      serviceState: (client.serviceAddress as { state?: string }).state ?? "",
      hasIep: client.hasIep,
      hasSecondaryPayor: client.payors.some((p) => p.priority === "secondary"),
      events: client.events,
    },
    authorization: auth
      ? {
          kind: auth.kind as "initial" | "reauth",
          startDate: toDay(auth.startDate),
          endDate: toDay(auth.endDate),
          units: auth.units.map((u) => ({
            cptCode: u.cptCode,
            approvedUnits: u.approvedUnits,
            unitBasis: u.unitBasis as UnitBasis,
          })),
        }
      : null,
    sessions: sessions.map((s) => ({
      cptCode: s.cptCode,
      date: toDay(s.date),
      units: s.units,
      inPerson: s.inPerson,
      providerId: s.providerId,
      providerRole: s.providerRole,
      startMinute: s.startMinute,
    })),
    attachments: client.attachments.map((a) => ({
      kind: a.kind,
      title: a.title,
      documentDate: a.documentDate ? toDay(a.documentDate) : null,
    })),
    plan: plan
      ? {
          type: plan.type as "initial" | "reauth",
          sections: plan.sections.map((s) => ({
            key: s.key,
            state: s.state,
            hasContent: s.content.trim().length > 0,
          })),
          includesEvaluationDate:
            diagnoses.some((d) => d.evaluationDate) &&
            plan.sections.some((s) => s.key === "assessment" && s.content.trim().length > 0),
          allApprovedByBcba: plan.sections.length > 0 && plan.sections.every((s) => s.state === "approved"),
        }
      : null,
    offices,
    packetSubmitted: plan?.packet?.status === "submitted",
  };
  return { ctx, payorId: primary?.payorId ?? null, authorizationId: auth?.id ?? null };
}

export async function evaluateClientRules(tx: Tx, clientId: string, asOf: Day, planId?: string | null) {
  const { ctx, payorId } = await buildEvalContext(tx, clientId, asOf, planId);
  if (!payorId) return { ctx, results: [] };
  const rules = await loadRules(tx, payorId);
  return { ctx, results: evaluateRules(rules, ctx) };
}
