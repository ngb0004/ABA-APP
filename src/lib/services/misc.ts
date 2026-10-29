import type { Prisma } from "@prisma/client";
import { audit } from "../audit";
import { withOrg, type OrgCtx } from "../db";
import { ageYears, toDay, type Day } from "../dates";
import { masteryDefaults, tokenizeMastery } from "../goals/tokenize";
import { validateDraft, validateSubmission, FIELD_BY_ID, type IntakeAnswers } from "../intake/schema";
import { HttpError } from "../log";
import { can, requirePermission } from "../permissions";

export async function saveIntake(
  ctx: OrgCtx,
  clientId: string,
  answers: unknown,
  submit: boolean,
  asOf: Day,
) {
  requirePermission(ctx.role, "intake:write");
  return withOrg(ctx, async (tx) => {
    const client = await tx.client.findUniqueOrThrow({ where: { id: clientId }, include: { intakes: true } });
    const existing = client.intakes[0];
    const draft = validateDraft(answers);
    if (!draft.ok) throw new HttpError(422, draft.issues.map((i) => `${i.fieldId}: ${i.message}`).join("; "));
    // Restricted answers can only be written by roles that may read them.
    if (
      !can(ctx.role, "client:read_restricted") &&
      Object.keys(draft.answers).some((k) => FIELD_BY_ID.get(k)?.sensitivity === "restricted")
    )
      throw new HttpError(403, "Restricted fields are BCBA only");
    const merged = { ...((existing?.answers ?? {}) as IntakeAnswers), ...draft.answers };
    if (submit) {
      const v = validateSubmission(merged, ageYears(toDay(client.dob), asOf));
      if (!v.ok)
        throw new HttpError(
          422,
          `Answer every field or mark it none / not applicable: ${v.issues.map((i) => FIELD_BY_ID.get(i.fieldId)?.label ?? i.fieldId).join("; ")}`,
        );
    }
    const data = {
      answers: merged as Prisma.InputJsonValue,
      status: submit ? "submitted" : (existing?.status ?? "draft"),
      ...(submit ? { submittedAt: new Date() } : {}),
    };
    if (existing) await tx.intake.update({ where: { id: existing.id }, data });
    else await tx.intake.create({ data: { orgId: ctx.orgId, clientId, ...data } });
  });
}

const DEFICIT_FOR: Record<string, string> = {
  communication: "communication",
  social_play: "social_interaction",
  behavior_reduction: "restricted_repetitive_behavior",
  replacement: "communication",
  caregiver: "communication",
  other: "adaptive",
};

export async function addGoalFromTemplate(ctx: OrgCtx, clientId: string, templateId: string) {
  requirePermission(ctx.role, "goal:write");
  return withOrg(ctx, async (tx) => {
    const t = await tx.goalTemplate.findUniqueOrThrow({ where: { id: templateId } });
    const client = await tx.client.findUniqueOrThrow({
      where: { id: clientId },
      include: {
        diagnoses: true,
        plans: { where: { status: "draft" }, orderBy: { createdAt: "desc" }, take: 1 },
      },
    });
    const max = await tx.goal.aggregate({ where: { clientId }, _max: { ordinal: true } });
    const ordinal = (max._max.ordinal ?? 0) + 1;
    const deficit = DEFICIT_FOR[t.category] ?? "communication";
    const dx =
      client.diagnoses.find((d) => d.deficitAreas.includes(deficit)) ??
      client.diagnoses.find((d) => d.isPrimary) ??
      client.diagnoses[0];
    // The baseline placeholder becomes a sourced token; other brackets stay for the BCBA to fill.
    const rationale = t.rationaleText.replace(/\[X\]%/g, `{{goal.${ordinal}.baseline_pct}}`);
    const goal = await tx.goal.create({
      data: {
        orgId: ctx.orgId,
        clientId,
        planId: client.plans[0]?.id ?? null,
        templateId: t.id,
        diagnosisId: dx?.id ?? null,
        ordinal,
        domain: t.domainName,
        tier: t.tier,
        category: t.category,
        deficitArea: deficit,
        measure: t.category === "behavior_reduction" ? "frequency" : "percent",
        linkedMilestones: t.linkedMilestones as Prisma.InputJsonValue,
        objective: tokenizeMastery(t.goalText, ordinal),
        ...masteryDefaults(t.goalText),
        rationalePattern: t.rationalePattern,
        rationale,
        baselineSource: { kind: "datapoints", window: "first_3" },
      },
    });
    await audit(tx, { action: "goal:create", entityType: "Goal", entityId: goal.id, meta: { templateId } });
    return goal;
  });
}

export async function listAudit(ctx: OrgCtx, limit = 200) {
  requirePermission(ctx.role, "audit:read");
  return withOrg(ctx, (tx) => tx.auditEvent.findMany({ orderBy: { createdAt: "desc" }, take: limit }));
}
