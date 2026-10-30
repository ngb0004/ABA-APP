/**
 * Assessments of any type: entry, editing while draft, BCBA confirmation, and one list that
 * also shows the client's VB-MAPP administrations (adapted; VB-MAPP keeps its own import).
 *
 * Permissions mirror VB-MAPP: entering and editing as `vbmapp:import`, confirming as
 * `vbmapp:confirm`, reading as `client:read`. Every write goes through withOrg (RLS + audit)
 * and records a semantic audit event with ids and catalog keys only.
 */
import { audit } from "../audit";
import { assessmentCatalog, type Catalog } from "../assessments/catalog";
import { validateAssessment, type NormalizedAssessment } from "../assessments/validate";
import {
  assessmentItem,
  groupAssessments,
  newestFirst,
  vbmappItem,
  type AssessmentItem,
} from "../assessments/view";
import { withOrg, type OrgCtx, type Tx } from "../db";
import { dayToDate, toDay } from "../dates";
import { HttpError } from "../log";
import { requirePermission } from "../permissions";
import { afterAssessmentConfirmed, dropFromPlanSelections } from "./plans";
import { assertClientActive } from "./client-status";

const scoreRows = (orgId: string, assessmentId: string, v: NormalizedAssessment) =>
  v.scores.map((s) => ({
    orgId,
    assessmentId,
    scaleKey: s.scaleKey,
    scaleName: s.scaleName,
    scaleKind: s.scaleKind,
    value: s.value,
    possible: s.possible,
  }));

const header = (v: NormalizedAssessment) => ({
  typeKey: v.typeKey,
  module: v.module,
  form: v.form,
  respondent: v.respondent,
  customName: v.customName,
  administeredOn: dayToDate(v.administeredOn),
  administeredBy: v.administeredBy,
  notes: v.notes,
});

async function clientOf(tx: Tx, clientId: string) {
  if (!(await tx.client.findUnique({ where: { id: clientId }, select: { id: true } })))
    throw new HttpError(404, "Not found");
}

async function draftOf(tx: Tx, clientId: string, id: string) {
  const a = await tx.assessment.findFirst({ where: { id, clientId } });
  if (!a) throw new HttpError(404, "Not found");
  if (a.status !== "draft")
    throw new HttpError(409, "This assessment is confirmed; its scores can no longer change");
  return a;
}

export async function createAssessment(
  ctx: OrgCtx,
  clientId: string,
  input: unknown,
  asOf: string = toDay(new Date()),
  catalog: Catalog = assessmentCatalog(),
) {
  requirePermission(ctx.role, "assessment:write");
  const v = validateAssessment(catalog, input, asOf);
  return withOrg(ctx, async (tx) => {
    await assertClientActive(tx, clientId);
    await clientOf(tx, clientId);
    const row = await tx.assessment.create({
      data: {
        orgId: ctx.orgId,
        clientId,
        ...header(v),
        source: "manual",
        createdById: ctx.userId,
      },
      select: { id: true },
    });
    if (v.scores.length) await tx.assessmentScore.createMany({ data: scoreRows(ctx.orgId, row.id, v) });
    await audit(tx, {
      action: "assessment:create",
      entityType: "Assessment",
      entityId: row.id,
      meta: { typeKey: v.typeKey, module: v.module, scores: v.scores.length },
    });
    return row;
  });
}

export async function updateAssessment(
  ctx: OrgCtx,
  clientId: string,
  id: string,
  input: unknown,
  asOf: string = toDay(new Date()),
  catalog: Catalog = assessmentCatalog(),
) {
  requirePermission(ctx.role, "assessment:write");
  const v = validateAssessment(catalog, input, asOf);
  return withOrg(ctx, async (tx) => {
    await assertClientActive(tx, clientId);
    const a = await draftOf(tx, clientId, id);
    if (a.typeKey !== v.typeKey || a.module !== v.module)
      throw new HttpError(422, "The assessment type cannot change; delete this draft and add a new one");
    await tx.assessment.update({ where: { id }, data: header(v) });
    await tx.assessmentScore.deleteMany({ where: { assessmentId: id } });
    if (v.scores.length) await tx.assessmentScore.createMany({ data: scoreRows(ctx.orgId, id, v) });
    await audit(tx, {
      action: "assessment:update",
      entityType: "Assessment",
      entityId: id,
      meta: { typeKey: v.typeKey, scores: v.scores.length },
    });
    return { id };
  });
}

/** A BCBA confirms the scores; reviewer and time are recorded and the row is locked. */
export async function confirmAssessment(ctx: OrgCtx, clientId: string, id: string) {
  requirePermission(ctx.role, "assessment:confirm");
  if (!ctx.userId) throw new HttpError(403, "Sign in to confirm an assessment");
  const userId = ctx.userId;
  return withOrg(ctx, async (tx) => {
    await assertClientActive(tx, clientId);
    await draftOf(tx, clientId, id);
    if (!(await tx.assessmentScore.count({ where: { assessmentId: id } })))
      throw new HttpError(422, "Enter at least one score before confirming");
    await tx.assessment.update({
      where: { id },
      data: { status: "confirmed", reviewerId: userId, reviewedAt: new Date() },
    });
    await audit(tx, { action: "assessment:confirm", entityType: "Assessment", entityId: id });
    await afterAssessmentConfirmed(tx, ctx, id);
    return { id };
  });
}

export async function deleteAssessment(ctx: OrgCtx, clientId: string, id: string) {
  requirePermission(ctx.role, "assessment:write");
  return withOrg(ctx, async (tx) => {
    await assertClientActive(tx, clientId);
    const a = await draftOf(tx, clientId, id);
    await dropFromPlanSelections(tx, clientId, id);
    await tx.assessmentScore.deleteMany({ where: { assessmentId: id } });
    await tx.assessment.delete({ where: { id } });
    await audit(tx, {
      action: "assessment:delete",
      entityType: "Assessment",
      entityId: id,
      meta: { typeKey: a.typeKey },
    });
  });
}

/** Every assessment of the client, VB-MAPP included, newest first and grouped by repeats. */
export async function listAssessments(ctx: OrgCtx, clientId: string, catalog: Catalog = assessmentCatalog()) {
  requirePermission(ctx.role, "client:read");
  return withOrg(ctx, async (tx) => {
    const client = await tx.client.findUnique({
      where: { id: clientId },
      select: { id: true, firstName: true, lastName: true },
    });
    if (!client) throw new HttpError(404, "Not found");
    const [rows, admins, pendingImports] = await Promise.all([
      tx.assessment.findMany({ where: { clientId }, include: { scores: true } }),
      tx.vbmappAdministration.findMany({
        where: { clientId },
        select: {
          id: true,
          adminNumber: true,
          testDate: true,
          testerInitials: true,
          totals: true,
          verified: true,
          reviewedAt: true,
        },
      }),
      tx.assessmentImport.findMany({
        where: { clientId, status: "pending" },
        select: { id: true, filename: true, typeKey: true, module: true, createdAt: true },
        orderBy: { createdAt: "desc" },
      }),
    ]);
    const items: AssessmentItem[] = newestFirst([
      ...rows.map((r) => assessmentItem(catalog, clientId, r)),
      ...admins.map((a) => vbmappItem(catalog, clientId, a)),
    ]);
    return { client, items, groups: groupAssessments(items, catalog), pendingImports };
  });
}
