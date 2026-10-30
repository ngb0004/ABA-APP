/**
 * Score file imports for assessments other than VB-MAPP: upload (any supported format) →
 * deterministic extraction (no AI) → review screen → the BCBA checks every number and confirms
 * → a confirmed Assessment with provenance on each score. Or discard.
 *
 * Never stored: the file's bytes or text, names, birth dates, or IDs found in it (only flags).
 * Permissions mirror the manual entry: upload and discard as `assessment:write`, confirm as
 * `assessment:confirm`, review as `client:read`.
 */
import type { Prisma } from "@prisma/client";
import { z } from "zod";
import { audit, sha256 } from "../audit";
import {
  assessmentCatalog,
  catalogType,
  scalesFor,
  type Catalog,
  type CatalogType,
} from "../assessments/catalog";
import { extractAssessmentFile, type Proposal } from "../assessments/extract";
import { validateAssessment, AssessmentValidationError } from "../assessments/validate";
import { withOrg, type OrgCtx } from "../db";
import { dayToDate, toDay } from "../dates";
import { assertDemoUploadAllowed } from "../demo";
import { HttpError } from "../log";
import { requirePermission } from "../permissions";

const ChosenType = z.object({
  typeKey: z.string().trim().min(1, "Choose the assessment").max(48),
  module: z
    .string()
    .trim()
    .max(48)
    .nullish()
    .transform((v) => (v ? v : null)),
});

/** The catalog type an import is for. VB-MAPP keeps its own workbook import. */
export function importableType(
  catalog: Catalog,
  input: unknown,
): { type: CatalogType; module: string | null } {
  const { typeKey, module } = ChosenType.parse(input);
  const type = catalogType(catalog, typeKey);
  if (!type) throw new HttpError(422, `Unknown assessment type "${typeKey}"`);
  if (type.entry === "vbmapp_import")
    throw new HttpError(422, "VB-MAPP is imported from its scoring workbook on the VB-MAPP page");
  if (type.modules.length) {
    if (!module) throw new HttpError(422, `Choose the ${type.name} module`);
    if (!type.modules.some((m) => m.key === module))
      throw new HttpError(422, `Unknown ${type.name} module "${module}"`);
  } else if (module) throw new HttpError(422, `${type.name} has no modules`);
  return { type, module };
}

const safeFilename = (name: string) => name.replace(/[^\w.\- ]/g, "_").slice(0, 120) || "upload";

export async function uploadAssessmentImport(
  ctx: OrgCtx,
  clientId: string,
  input: { filename: string; data: Buffer; typeKey: unknown; module?: unknown },
  asOf: string = toDay(new Date()),
  catalog: Catalog = assessmentCatalog(),
) {
  requirePermission(ctx.role, "assessment:write");
  const { type, module } = importableType(catalog, { typeKey: input.typeKey, module: input.module });
  assertDemoUploadAllowed(input.data);
  // Read outside the transaction: OCR can take seconds. Nothing read is kept but the proposal.
  const { file, proposal } = await extractAssessmentFile({
    filename: input.filename,
    data: input.data,
    catalog,
    type,
    module,
    asOf,
  });
  return withOrg(ctx, async (tx) => {
    if (!(await tx.client.findUnique({ where: { id: clientId }, select: { id: true } })))
      throw new HttpError(404, "Not found");
    const phiDetected = proposal.phi.name || proposal.phi.dob || proposal.phi.memberId;
    const row = await tx.assessmentImport.create({
      data: {
        orgId: ctx.orgId,
        clientId,
        typeKey: type.key,
        module,
        filename: safeFilename(input.filename),
        fileSha256: sha256(input.data),
        mime: file.mime,
        format: file.format,
        phiDetected,
        parsed: proposal as unknown as Prisma.InputJsonValue,
        flags: proposal.flags as unknown as Prisma.InputJsonValue,
        createdById: ctx.userId,
      },
      select: { id: true },
    });
    await audit(tx, {
      action: "assessment_import:upload",
      entityType: "AssessmentImport",
      entityId: row.id,
      meta: {
        typeKey: type.key,
        module,
        format: file.format,
        proposed: proposal.scores.length,
        phiDetected,
        flags: proposal.flags.map((f) => f.code),
      },
    });
    return { importId: row.id, proposal };
  });
}

/** The import and its proposal, for the review screen. */
export async function assessmentImportReview(ctx: OrgCtx, importId: string) {
  requirePermission(ctx.role, "client:read");
  return withOrg(ctx, async (tx) => {
    const imp = await tx.assessmentImport.findUnique({
      where: { id: importId },
      include: {
        client: { select: { id: true, firstName: true, lastName: true } },
        assessments: { select: { id: true } },
      },
    });
    if (!imp) throw new HttpError(404, "Not found");
    return { import: imp, proposal: imp.parsed as unknown as Proposal };
  });
}

const Num = z.number().finite().nullish();
export const ConfirmImportSchema = z.object({
  stripPhi: z.boolean().default(false),
  administeredOn: z.string(),
  administeredBy: z.string(),
  form: z.string().nullish(),
  respondent: z.string().nullish(),
  customName: z.string().nullish(),
  notes: z.string().nullish(),
  scores: z
    .array(
      z.object({
        scaleKey: z.string().max(60),
        value: Num,
        possible: Num,
        reviewed: z.boolean().default(false),
      }),
    )
    .max(120)
    .default([]),
  customScales: z
    .array(
      z.object({
        name: z.string().max(80).nullish(),
        kind: z.string().max(40).nullish(),
        value: Num,
        possible: Num,
        reviewed: z.boolean().default(false),
      }),
    )
    .max(60)
    .default([]),
});

/**
 * The BCBA confirms the reviewed scores: every number must be marked as checked against the file
 * (no silent acceptance). Creates a confirmed Assessment (source "import") with provenance on
 * each score, and closes the import.
 */
export async function confirmAssessmentImport(
  ctx: OrgCtx,
  importId: string,
  input: unknown,
  asOf: string = toDay(new Date()),
  catalog: Catalog = assessmentCatalog(),
) {
  requirePermission(ctx.role, "assessment:confirm");
  if (!ctx.userId) throw new HttpError(403, "Sign in to confirm an assessment");
  const userId = ctx.userId;
  const body = ConfirmImportSchema.parse(input);
  return withOrg(ctx, async (tx) => {
    const imp = await tx.assessmentImport.findUnique({ where: { id: importId } });
    if (!imp) throw new HttpError(404, "Not found");
    if (imp.status !== "pending") throw new HttpError(409, "This import was already reviewed");
    if (imp.phiDetected && !body.stripPhi)
      throw new HttpError(
        422,
        "The file contains a name, date of birth, or ID. Confirm that none of it is imported to continue.",
      );
    const type = catalogType(catalog, imp.typeKey);
    if (!type) throw new HttpError(422, `Unknown assessment type "${imp.typeKey}"`);
    const names = new Map(scalesFor(type, imp.module).map((s) => [s.key, s.name]));
    const unchecked = [
      ...body.scores
        .filter((s) => (s.value ?? null) !== null && !s.reviewed)
        .map((s) => names.get(s.scaleKey) ?? s.scaleKey),
      ...body.customScales
        .filter((s) => (s.value ?? null) !== null && !s.reviewed)
        .map((s) => s.name || "An added scale"),
    ];
    if (unchecked.length)
      throw new AssessmentValidationError(unchecked.map((n) => `${n}: check this score against the file`));
    const v = validateAssessment(catalog, { ...body, typeKey: imp.typeKey, module: imp.module }, asOf);
    if (!v.scores.length) throw new HttpError(422, "Enter at least one score before confirming");

    const proposal = imp.parsed as unknown as Proposal;
    const proposed = new Map(proposal.scores.map((s) => [s.scaleKey, s]));
    let edited = 0;
    let byHand = 0;
    const a = await tx.assessment.create({
      data: {
        orgId: ctx.orgId,
        clientId: imp.clientId,
        typeKey: v.typeKey,
        module: v.module,
        form: v.form,
        respondent: v.respondent,
        customName: v.customName,
        administeredOn: dayToDate(v.administeredOn),
        administeredBy: v.administeredBy,
        notes: v.notes,
        source: "import",
        importId: imp.id,
        status: "confirmed",
        reviewerId: userId,
        reviewedAt: new Date(),
        createdById: userId,
      },
      select: { id: true },
    });
    await tx.assessmentScore.createMany({
      data: v.scores.map((s) => {
        const p = proposed.get(s.scaleKey);
        const changed = !!p && (p.value !== s.value || p.possible !== s.possible);
        if (changed) edited += 1;
        if (!p) byHand += 1;
        const provenance = p
          ? {
              importId: imp.id,
              format: imp.format,
              location: p.location,
              matchedLabel: p.matchedLabel,
              confidence: p.confidence,
              proposed: { value: p.value, possible: p.possible },
              edited: changed,
              reviewedBy: userId,
            }
          : { importId: imp.id, format: imp.format, location: null, enteredByHand: true, reviewedBy: userId };
        return {
          orgId: ctx.orgId,
          assessmentId: a.id,
          scaleKey: s.scaleKey,
          scaleName: s.scaleName,
          scaleKind: s.scaleKind,
          value: s.value,
          possible: s.possible,
          provenance,
        };
      }),
    });
    await tx.assessmentImport.update({
      where: { id: imp.id },
      data: { status: "confirmed", reviewerId: userId, reviewedAt: new Date(), phiStripped: imp.phiDetected },
    });
    await audit(tx, {
      action: "assessment_import:confirm",
      entityType: "AssessmentImport",
      entityId: imp.id,
      meta: {
        assessmentId: a.id,
        typeKey: v.typeKey,
        scores: v.scores.length,
        edited,
        enteredByHand: byHand,
      },
    });
    await audit(tx, {
      action: "assessment:confirm",
      entityType: "Assessment",
      entityId: a.id,
      meta: { typeKey: v.typeKey, source: "import", importId: imp.id },
    });
    return { assessmentId: a.id, clientId: imp.clientId };
  });
}

export async function discardAssessmentImport(ctx: OrgCtx, importId: string) {
  requirePermission(ctx.role, "assessment:write");
  if (!ctx.userId) throw new HttpError(403, "Sign in to discard an import");
  const userId = ctx.userId;
  return withOrg(ctx, async (tx) => {
    const imp = await tx.assessmentImport.findUnique({
      where: { id: importId },
      select: { status: true, clientId: true },
    });
    if (!imp) throw new HttpError(404, "Not found");
    if (imp.status !== "pending") throw new HttpError(409, "This import was already reviewed");
    await tx.assessmentImport.update({
      where: { id: importId },
      data: { status: "discarded", reviewerId: userId, reviewedAt: new Date() },
    });
    await audit(tx, {
      action: "assessment_import:discard",
      entityType: "AssessmentImport",
      entityId: importId,
    });
    return { clientId: imp.clientId };
  });
}
