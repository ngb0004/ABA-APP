/**
 * Per-client payor requirements: for each of the client's insurances, the rules that apply to this
 * client (payor, plan state, and plan type), where each stands from the evaluator, the benefits
 * checks on record, and the requirements read from the client's confirmed payor letters.
 * Read-only.
 */
import { withOrg, type OrgCtx } from "../db";
import { toDay, type Day } from "../dates";
import { HttpError, registerSensitiveName } from "../log";
import { fundingContradicts, type PlanFunding } from "../payors/benefits";
import type { EvalContext } from "../payors/context";
import {
  RULE_CATEGORIES,
  requirementStatus,
  ruleCategory,
  type RequirementStatus,
} from "../payors/categories";
import { effectivePlanState, evaluateRules, planTypeFit, scopeFindings } from "../payors/evaluate";
import type { PlanType, Rule, ScopeFinding } from "../payors/types";
import { requirePermission } from "../permissions";
import { buildEvalContext, loadRules } from "./payors";

export type Requirement = {
  rule: Rule;
  status: RequirementStatus;
  /** The evaluator's one-line result for this client. */
  message: string;
  evidence: string[];
};

export type InsuranceRequirements = {
  id: string;
  priority: string;
  memberId: string;
  planName: string | null;
  payor: { id: string; name: string; lineOfBusiness: string; states: string[] };
  planType: PlanType;
  /** The state the plan was issued in, else the client's service state ("" when neither is known). */
  planState: string;
  planStateRecorded: boolean;
  scope: ScopeFinding[];
  groups: { key: string; label: string; items: Requirement[] }[];
  /** Rules limited to plan types this plan is not (hidden from the groups). */
  otherPlanTypeRules: number;
  checks: {
    id: string;
    checkedOn: Day;
    checkedBy: string | null;
    method: string;
    referenceNumber: string | null;
    abaCovered: string;
    priorAuthRequired: string;
    planFunding: string;
    ageLimitYears: number | null;
    visitOrHourLimits: string | null;
    notes: string | null;
  }[];
  /** The latest check's funding answer contradicts the plan type on record. */
  fundingConflict: boolean;
};

export type LetterRequirements = {
  id: string;
  /** When the letter was received into Yoma (letters carry no structured date of their own). */
  date: Day;
  classification: string | null;
  requirements: string[];
};

const GROUP_ORDER = [...RULE_CATEGORIES.map((c) => c.key), "other"];
const GROUP_LABEL = (key: string) =>
  RULE_CATEGORIES.find((c) => c.key === key)?.label ?? "Other requirements";

/** The data behind /clients/[id]/requirements. Same permission as viewing plans and packets. */
export async function clientRequirements(ctx: OrgCtx, clientId: string, asOf: Day) {
  requirePermission(ctx.role, "client:read");
  return withOrg(ctx, async (tx) => {
    const client = await tx.client.findUnique({
      where: { id: clientId },
      include: {
        payors: { include: { payor: true }, orderBy: { priority: "asc" } },
        plans: { orderBy: { createdAt: "desc" }, take: 1, select: { id: true } },
      },
    });
    if (!client) throw new HttpError(404, "Not found");
    registerSensitiveName(client.firstName);
    registerSensitiveName(client.lastName);

    // The evaluator context is built around the primary insurance and the latest authorization.
    const { ctx: base, authorizationId } = await buildEvalContext(
      tx,
      clientId,
      asOf,
      client.plans[0]?.id ?? null,
    );
    const auth = authorizationId
      ? await tx.authorization.findUnique({ where: { id: authorizationId }, select: { payorId: true } })
      : null;
    const primary = client.payors.find((p) => p.priority === "primary") ?? client.payors[0];

    const checks = await tx.benefitsCheck.findMany({
      where: { clientId },
      orderBy: [{ checkedOn: "desc" }, { createdAt: "desc" }],
    });
    // Who checked: names of this practice's members (the user table holds identity only).
    const members = await tx.membership.findMany({
      where: { orgId: ctx.orgId, userId: { in: [...new Set(checks.map((c) => c.checkedByUserId))] } },
      include: { user: { select: { name: true } } },
    });
    const nameOf = new Map(members.map((m) => [m.userId, m.user.name]));

    const insurances: InsuranceRequirements[] = [];
    for (const cp of client.payors) {
      const planType = cp.planType as PlanType;
      // A secondary plan is judged on its own plan type and state, and only against an
      // authorization from its own payor.
      const sameAuth = auth?.payorId === cp.payorId;
      const evalCtx: EvalContext =
        cp.id === primary?.id
          ? base
          : {
              ...base,
              client: { ...base.client, planType, planState: cp.planState },
              payor: {
                key: cp.payor.key,
                name: cp.payor.name,
                states: cp.payor.states,
                lineOfBusiness: cp.payor.lineOfBusiness,
              },
              authorization: sameAuth ? base.authorization : null,
              sessions: sameAuth ? base.sessions : [],
            };
      const rules = await loadRules(tx, cp.payorId);
      const applicable = rules.filter((r) => planTypeFit(r, planType) !== "no");
      const results = evaluateRules(applicable, evalCtx);
      const byGroup = new Map<string, Requirement[]>();
      for (const r of results) {
        const key = ruleCategory(r.rule.type);
        const list = byGroup.get(key) ?? [];
        list.push({
          rule: r.rule,
          status: requirementStatus(r.rawStatus),
          message: r.message,
          evidence: r.evidence,
        });
        byGroup.set(key, list);
      }
      const own = checks.filter((c) => c.clientPayorId === cp.id);
      insurances.push({
        id: cp.id,
        priority: cp.priority,
        memberId: cp.memberId,
        planName: cp.planName,
        payor: {
          id: cp.payorId,
          name: cp.payor.name,
          lineOfBusiness: cp.payor.lineOfBusiness,
          states: cp.payor.states,
        },
        planType,
        planState: effectivePlanState(evalCtx),
        planStateRecorded: !!cp.planState,
        scope: scopeFindings(rules, evalCtx),
        groups: GROUP_ORDER.filter((k) => byGroup.has(k)).map((k) => ({
          key: k,
          label: GROUP_LABEL(k),
          items: byGroup.get(k)!,
        })),
        otherPlanTypeRules: rules.length - applicable.length,
        checks: own.map((c) => ({
          id: c.id,
          checkedOn: toDay(c.checkedOn),
          checkedBy: nameOf.get(c.checkedByUserId) ?? null,
          method: c.method,
          referenceNumber: c.referenceNumber,
          abaCovered: c.abaCovered,
          priorAuthRequired: c.priorAuthRequired,
          planFunding: c.planFunding,
          ageLimitYears: c.ageLimitYears,
          visitOrHourLimits: c.visitOrHourLimits,
          notes: c.notes,
        })),
        fundingConflict: !!own[0] && fundingContradicts(planType, own[0].planFunding as PlanFunding),
      });
    }

    // Requirements the payor wrote to this client, from letters the BCBA confirmed.
    const letterRows = await tx.payorLetter.findMany({
      where: { clientId },
      orderBy: { createdAt: "desc" },
      select: { id: true, createdAt: true, classification: true, status: true, extracted: true },
    });
    const letters: LetterRequirements[] = letterRows
      .filter((l) => l.status === "confirmed")
      .map((l) => ({
        id: l.id,
        date: toDay(l.createdAt),
        classification: l.classification,
        requirements:
          ((l.extracted as { requirements?: unknown }).requirements as string[] | undefined) ?? [],
      }))
      .filter((l) => l.requirements.length > 0);
    const unconfirmedLetters = letterRows.filter((l) => l.status !== "confirmed").length;

    return {
      client: { id: client.id, firstName: client.firstName, lastName: client.lastName },
      insurances,
      letters,
      unconfirmedLetters,
      // Checks whose insurance was removed since (kept as history).
      removedInsuranceChecks: checks.filter((c) => !c.clientPayorId).length,
    };
  });
}
