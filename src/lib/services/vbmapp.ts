/**
 * VB-MAPP import workflow: upload → parse (data only, never macros) → review
 * screen with flags → BCBA confirms (reviewer and time recorded) → stored
 * administrations with carry-forward of previously mastered milestones.
 */
import type { Prisma } from "@prisma/client";
import { audit, sha256 } from "../audit";
import { withOrg, type OrgCtx } from "../db";
import { assertDemoUploadAllowed } from "../demo";
import { HttpError } from "../log";
import { requirePermission } from "../permissions";
import { carryForward, totalsFromScores, type GridScore } from "../vbmapp/carry-forward";
import { parseVbmappWorkbook, type ParsedWorkbook } from "../vbmapp/parse";

export async function uploadVbmapp(ctx: OrgCtx, clientId: string, filename: string, data: Buffer) {
  requirePermission(ctx.role, "vbmapp:import");
  if (!/\.(xlsm|xlsx)$/i.test(filename)) throw new HttpError(400, "Upload a .xlsm or .xlsx VB-MAPP workbook");
  assertDemoUploadAllowed(data);
  let parsed: ParsedWorkbook;
  try {
    parsed = parseVbmappWorkbook(data);
  } catch (e) {
    throw new HttpError(400, (e as Error).message);
  }
  return withOrg(ctx, async (tx) => {
    await tx.client.findUniqueOrThrow({ where: { id: clientId } });
    const imp = await tx.vbmappImport.create({
      data: {
        orgId: ctx.orgId,
        clientId,
        filename: filename.replace(/[^\w.\- ]/g, "_").slice(0, 120),
        fileSha256: sha256(data),
        // The workbook itself is not stored; neither are the name/DOB header cells.
        parsed: parsed as unknown as Prisma.InputJsonValue,
        phiDetected: parsed.phi.name || parsed.phi.dob,
      },
    });
    return { importId: imp.id, ...parsed };
  });
}

export async function importReview(ctx: OrgCtx, importId: string) {
  requirePermission(ctx.role, "client:read");
  return withOrg(ctx, async (tx) => {
    const imp = await tx.vbmappImport.findUniqueOrThrow({ where: { id: importId } });
    const prior = await tx.vbmappAdministration.findMany({
      where: { clientId: imp.clientId, verified: true },
      include: { scores: true },
      orderBy: { adminNumber: "asc" },
    });
    const parsed = imp.parsed as unknown as ParsedWorkbook;
    const preview = parsed.administrations.map((a) => {
      const earlier = prior.filter((p) => p.adminNumber < a.adminNumber || p.importId !== imp.id);
      const merged = carryForward(
        earlier.filter((p) => p.adminNumber < a.adminNumber).map((p) => p.scores.map(toGrid)),
        a.scores,
      );
      return { ...a, merged, mergedTotals: totalsFromScores(merged) };
    });
    return { import: imp, parsed, preview, prior };
  });
}

const toGrid = (s: {
  level: number;
  domain: string;
  milestone: number;
  score: number;
  firstAdmin: number;
  carriedForward?: boolean;
}): GridScore => ({
  level: s.level,
  domain: s.domain,
  milestone: s.milestone,
  score: s.score as 0.5 | 1,
  firstAdmin: s.firstAdmin,
  carriedForward: s.carriedForward,
});

export async function confirmImport(ctx: OrgCtx, importId: string, opts: { stripPhi: boolean }) {
  requirePermission(ctx.role, "vbmapp:confirm");
  return withOrg(ctx, async (tx) => {
    const imp = await tx.vbmappImport.findUniqueOrThrow({ where: { id: importId } });
    if (imp.status !== "pending") throw new HttpError(409, "Import already reviewed");
    if (imp.phiDetected && !opts.stripPhi)
      throw new HttpError(
        422,
        "The workbook contains a name or date of birth. Confirm stripping it to import.",
      );
    const parsed = imp.parsed as unknown as ParsedWorkbook;
    const created: string[] = [];
    for (const a of parsed.administrations) {
      const prior = await tx.vbmappAdministration.findMany({
        where: { clientId: imp.clientId, verified: true, adminNumber: { lt: a.adminNumber } },
        include: { scores: true },
      });
      const merged = carryForward(
        prior.map((p) => p.scores.map(toGrid)),
        a.scores,
      );
      // A re-imported administration number replaces the earlier version.
      const existing = await tx.vbmappAdministration.findMany({
        where: { clientId: imp.clientId, adminNumber: a.adminNumber },
      });
      for (const e of existing) {
        await tx.milestoneScore.deleteMany({ where: { administrationId: e.id } });
        await tx.vbmappAdministration.delete({ where: { id: e.id } });
      }
      const adm = await tx.vbmappAdministration.create({
        data: {
          orgId: ctx.orgId,
          clientId: imp.clientId,
          importId: imp.id,
          adminNumber: a.adminNumber,
          testDate: a.testDate ? new Date(`${a.testDate}T00:00:00Z`) : null,
          testerInitials: a.testerInitials,
          totals: totalsFromScores(merged) as Prisma.InputJsonValue,
          flags: parsed.flags.filter(
            (f) => f.admin === undefined || f.admin === a.adminNumber,
          ) as unknown as Prisma.InputJsonValue,
          verified: true,
          reviewerId: ctx.userId,
          reviewedAt: new Date(),
        },
      });
      await tx.milestoneScore.createMany({
        data: merged.map((s) => ({
          orgId: ctx.orgId,
          administrationId: adm.id,
          level: s.level,
          domain: s.domain,
          milestone: s.milestone,
          score: s.score,
          firstAdmin: s.firstAdmin,
          carriedForward: !!s.carriedForward,
        })),
      });
      created.push(adm.id);
    }
    await tx.vbmappImport.update({
      where: { id: importId },
      data: {
        status: "confirmed",
        reviewerId: ctx.userId,
        reviewedAt: new Date(),
        phiStripped: imp.phiDetected,
      },
    });
    await audit(tx, {
      action: "vbmapp:confirm",
      entityType: "VbmappImport",
      entityId: importId,
      meta: { administrations: created.length, flags: parsed.flags.map((f) => f.code) },
    });
    return { administrations: created };
  });
}

export async function discardImport(ctx: OrgCtx, importId: string) {
  requirePermission(ctx.role, "vbmapp:import");
  return withOrg(ctx, async (tx) => {
    await tx.vbmappImport.update({
      where: { id: importId },
      data: { status: "discarded", reviewerId: ctx.userId, reviewedAt: new Date() },
    });
  });
}
