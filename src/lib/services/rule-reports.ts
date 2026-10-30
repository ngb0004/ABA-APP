/**
 * "Report a problem" with a payor rule. Anyone who can read the rules can report one; Yoma's
 * curators review open reports and fix the library. A report never changes a rule's status.
 */
import { z } from "zod";
import { audit } from "../audit";
import { requireCurator } from "../auth/curator";
import { withOrg, type OrgCtx } from "../db";
import { HttpError } from "../log";
import { REPORT_NOTE_MAX as NOTE_MAX, REPORT_REASONS, type ReportReason } from "../payors/report-reasons";
import { requirePermission } from "../permissions";
import { looksLikePhiInNote } from "../rules-watch/text";

export const RESOLUTION_MAX = 500;

export const PHI_NOTE_MESSAGE =
  "That note looks like it has a client's information (a name, date of birth, or ID number). Describe the rule problem without it, and leave out long reference numbers.";

export const ReportInput = z.object({
  reason: z.enum(REPORT_REASONS.map(([k]) => k) as [ReportReason, ...ReportReason[]]),
  note: z.string().max(NOTE_MAX, `Keep the note under ${NOTE_MAX} characters`).optional().default(""),
});
export const ResolveInput = z.object({
  resolution: z.string().trim().min(1, "Say what was done").max(RESOLUTION_MAX),
});

/** File a problem report on a rule (its lineage). The note is checked for client information first. */
export async function reportRuleProblem(ctx: OrgCtx, ruleId: string, raw: unknown) {
  requirePermission(ctx.role, "payor:read");
  if (!ctx.userId) throw new HttpError(401, "Not authenticated");
  const input = ReportInput.parse(raw);
  const note = input.note.trim();
  if (looksLikePhiInNote(note)) {
    // Recorded without the note: the rejected text is never stored.
    await withOrg(ctx, (tx) =>
      audit(tx, {
        action: "rule_report:rejected",
        entityType: "PayorRule",
        entityId: ruleId,
        meta: { reason: input.reason, why: "looks_like_client_info", length: note.length },
      }),
    );
    throw new HttpError(422, PHI_NOTE_MESSAGE);
  }
  return withOrg(ctx, async (tx) => {
    const rule = await tx.payorRule.findUniqueOrThrow({ where: { id: ruleId } });
    if (!rule.lineageKey)
      throw new HttpError(409, "This rule has not been synced yet. Try again after the payor library sync.");
    const report = await tx.ruleReport.create({
      data: {
        orgId: ctx.orgId,
        lineageKey: rule.lineageKey,
        ruleId: rule.id,
        reason: input.reason,
        note,
        createdById: ctx.userId!,
      },
      select: { id: true },
    });
    await audit(tx, {
      action: "rule_report:create",
      entityType: "RuleReport",
      entityId: report.id,
      meta: { lineageKey: rule.lineageKey, ruleId: rule.id, reason: input.reason, noteLength: note.length },
    });
    return report;
  });
}

/** Open reports for the curator's review, oldest first, with the rule they are about. */
export async function listOpenReports(ctx: OrgCtx) {
  requirePermission(ctx.role, "payor:verify");
  await requireCurator(ctx);
  return withOrg(ctx, async (tx) => {
    const reports = await tx.ruleReport.findMany({
      where: { resolvedAt: null },
      orderBy: { createdAt: "asc" },
      take: 200,
    });
    const ruleIds = [...new Set(reports.map((r) => r.ruleId).filter((x): x is string => !!x))];
    const rules = await tx.payorRule.findMany({
      where: { id: { in: ruleIds } },
      select: { id: true, type: true, payor: { select: { name: true } } },
    });
    const byId = new Map(rules.map((r) => [r.id, r]));
    return reports.map((r) => {
      const rule = r.ruleId ? byId.get(r.ruleId) : undefined;
      return {
        id: r.id,
        lineageKey: r.lineageKey,
        ruleId: r.ruleId,
        ruleType: rule?.type ?? null,
        payorName: rule?.payor.name ?? null,
        reason: r.reason as ReportReason,
        note: r.note,
        createdAt: r.createdAt,
      };
    });
  });
}

/** A curator closes a report, saying what was done. */
export async function resolveRuleReport(ctx: OrgCtx, reportId: string, raw: unknown) {
  requirePermission(ctx.role, "payor:verify");
  await requireCurator(ctx);
  const { resolution } = ResolveInput.parse(raw);
  if (looksLikePhiInNote(resolution)) throw new HttpError(422, PHI_NOTE_MESSAGE);
  return withOrg(ctx, async (tx) => {
    const r = await tx.ruleReport.updateMany({
      where: { id: reportId, resolvedAt: null },
      data: { resolvedAt: new Date(), resolvedById: ctx.userId, resolution },
    });
    if (r.count !== 1) throw new HttpError(404, "No open report with that id");
    await audit(tx, { action: "rule_report:resolve", entityType: "RuleReport", entityId: reportId });
    return { id: reportId };
  });
}
