/**
 * Treatment plan builder. Section workflow: draft → edited → approved, one
 * section at a time, BCBA only. There is intentionally no "approve all".
 */
import type { Prisma } from "@prisma/client";
import { draftWithFirewall } from "../ai";
import { assessmentCatalog } from "../assessments/catalog";
import {
  assessmentWindowStart,
  defaultAssessmentSelection,
  redraftMarks,
  REDRAFT_REASON,
  sameSelection,
  seriesKey,
} from "../assessments/plan";
import { assessmentItem, newestFirst, vbmappItem } from "../assessments/view";
import { audit, sha256 } from "../audit";
import { withOrg, type OrgCtx, type Tx } from "../db";
import { toDay, type Day } from "../dates";
import { renderTokens, validateBcbaText } from "../firewall";
import { unresolvedPlaceholders } from "../goals/checks";
import { pseudonymNames } from "../intake/derive";
import { INTAKE_FIELDS, isNa, type IntakeAnswers } from "../intake/schema";
import { HttpError } from "../log";
import { requirePermission } from "../permissions";
import { buildSourcedContext, loadPlanBundle, type GoalStatus, type PlanBundle } from "../plan/context";
import { baseline, BASELINE_POINTS } from "../plan/progress";
import { lineDiff } from "../plan/diff";
import { buildDraftPayload, DRAFT_SYSTEM_PROMPT, tidyDraft } from "../plan/drafting";
import { goalGraphSvg } from "../plan/graphs";
import { exportBlockers, runPresubmissionAudit } from "../plan/presubmission";
import {
  sectionTakesField,
  SECTIONS,
  SECTION_BY_KEY,
  sectionDone,
  sectionsForTopic,
  type SectionDef,
} from "../plan/sections";
import type { RuleResult } from "../payors/types";
import { renderMilestonesGridSvg } from "../vbmapp/grid-svg";
import { evaluateClientRules, loadApplicableRules } from "./payors";

export type ItemState = { status: "answered" | "none"; note?: string };
export type RequiredItem = {
  key: string;
  label: string;
  status: "answered" | "none" | null;
  auto: boolean;
  note?: string;
};

export function requiredItemsFor(
  sectionKey: string,
  planType: string,
  answers: IntakeAnswers,
  rules: { type: string; params: Record<string, unknown>; source: { name: string | null } }[],
  stored: Record<string, ItemState>,
  /** Every section key in the plan: decides which structure a payor topic maps into. */
  planSectionKeys: string[] = SECTIONS.map((x) => x.key),
): RequiredItem[] {
  const def = SECTION_BY_KEY.get(sectionKey);
  if (!def) throw new HttpError(404, "Unknown section");
  const items: RequiredItem[] = [];
  for (const i of def.items.filter((x) => !x.reauthOnly || planType === "reauth"))
    items.push({
      key: i.key,
      label: i.label,
      status: stored[i.key]?.status ?? null,
      auto: false,
      note: stored[i.key]?.note,
    });
  for (const f of INTAKE_FIELDS.filter((x) => sectionTakesField(def, x) && x.sensitivity !== "restricted")) {
    const a = answers[f.id];
    const key = `intake:${f.id}`;
    const auto = a ? (isNa(a) ? "none" : "answered") : null;
    items.push({
      key,
      label: `Intake: ${f.label}`,
      status: stored[key]?.status ?? auto,
      auto: !stored[key] && auto !== null,
    });
  }
  for (const r of rules.filter((x) => x.type === "plan_content")) {
    for (const topic of (r.params.must_include as string[] | undefined) ?? []) {
      // A payor topic is answered in the first section that covers it.
      if (sectionsForTopic(topic, planSectionKeys)?.[0] !== def.key) continue;
      const key = `payor:${topic}`;
      if (items.some((x) => x.key === key)) continue;
      items.push({
        key,
        label: `Payor requires: ${topic.replace(/_/g, " ")}${r.source.name ? ` (${r.source.name})` : ""}`,
        status: stored[key]?.status ?? null,
        auto: false,
        note: stored[key]?.note,
      });
    }
  }
  return items;
}

async function primaryRules(tx: Tx, b: PlanBundle) {
  const p = b.client.payors.find((x) => x.priority === "primary");
  return p ? loadApplicableRules(tx, p) : [];
}

// ---------------------------------------------------------------- create

export async function createPlan(ctx: OrgCtx, clientId: string, type: "initial" | "reauth") {
  requirePermission(ctx.role, "plan:create");
  return withOrg(ctx, async (tx) => {
    const client = await tx.client.findUniqueOrThrow({
      where: { id: clientId },
      include: { payors: true, authorizations: { orderBy: { endDate: "desc" }, take: 1 } },
    });
    const primary = client.payors.find((p) => p.priority === "primary");
    const rules = primary ? await loadApplicableRules(tx, primary) : [];
    // Default assessments: confirmed ones from the last twelve months (or the authorization period).
    const auth = client.authorizations[0];
    const assessments = await tx.assessment.findMany({
      where: { clientId },
      select: { id: true, status: true, administeredOn: true },
    });
    const assessmentIds = defaultAssessmentSelection(
      assessments,
      assessmentWindowStart(toDay(new Date()), auth ? toDay(auth.startDate) : null),
    );
    // Record the payor document versions this plan is written against.
    const docs = new Map<string, { key: string; name: string; version: string }>();
    for (const r of rules)
      if (r.source.key && r.source.name)
        docs.set(r.source.key, {
          key: r.source.key,
          name: r.source.name,
          version: r.source.version ?? "unknown",
        });
    const plan = await tx.plan.create({
      data: {
        orgId: ctx.orgId,
        clientId,
        authorizationId: client.authorizations[0]?.id ?? null,
        type,
        createdById: ctx.userId,
        payorDocVersions: [...docs.values()],
        assessmentIds,
      },
    });
    await tx.planSection.createMany({
      data: SECTIONS.map((s, i) => ({
        orgId: ctx.orgId,
        planId: plan.id,
        key: s.key,
        ordinal: i + 1,
        title: s.title,
      })),
    });
    // Attach the client's goals that are not yet on a plan.
    await tx.goal.updateMany({ where: { clientId, planId: null }, data: { planId: plan.id } });
    await audit(tx, {
      action: "plan:create",
      entityType: "Plan",
      entityId: plan.id,
      meta: { type, assessments: assessmentIds.length },
    });
    return plan;
  });
}

// ---------------------------------------------------------------- read

export async function planView(ctx: OrgCtx, planId: string, asOf: Day) {
  requirePermission(ctx.role, "client:read");
  return withOrg(ctx, async (tx) => {
    const b = await loadPlanBundle(tx, planId);
    const sourced = buildSourcedContext(b, asOf);
    const rules = await primaryRules(tx, b);
    const { results, scope } = await evaluateClientRules(tx, b.client.id, asOf, planId);
    const checks = runPresubmissionAudit(b, sourced, results, asOf, scope);
    const answers = (b.intake?.answers ?? {}) as IntakeAnswers;
    const render = (text: string) => {
      try {
        return renderTokens(text, sourced, "html");
      } catch (e) {
        return `<span class="render-error">${(e as Error).message.replace(/[<>&]/g, "")}</span>`;
      }
    };
    const sections = b.plan.sections.map((s) => ({
      ...s,
      html: render(s.content),
      items: requiredItemsFor(
        s.key,
        b.plan.type,
        answers,
        rules,
        (s.items ?? {}) as Record<string, ItemState>,
        b.plan.sections.map((x) => x.key),
      ),
      bcbaOnly: SECTION_BY_KEY.get(s.key)?.bcbaOnly ?? false,
      conditional: !!SECTION_BY_KEY.get(s.key)?.condition,
      notApplicableReason: ((s.items ?? {}) as Record<string, ItemState>)[NOT_APPLICABLE_ITEM]?.note ?? null,
    }));
    const goals = b.goals.map((g) => ({
      ...g,
      objectiveHtml: render(g.objective),
      rationaleHtml: render(g.rationale),
      placeholders: unresolvedPlaceholders(g.objective, g.rationale),
      graph: goalGraphSvg({
        title: `Goal ${g.ordinal}: ${g.domain}`,
        measure: g.measure,
        points: g.dataPoints.map((p) => ({ date: toDay(p.date), value: p.value })),
        phaseChanges: g.phaseChanges.map((p) => ({ date: toDay(p.date), label: p.label })),
        masteryPct: g.masteryAccuracyPct,
      }),
    }));
    const latest = b.administrations.at(-1);
    const grid = latest
      ? renderMilestonesGridSvg(
          latest.scores.map((s) => ({
            level: s.level,
            domain: s.domain,
            milestone: s.milestone,
            score: s.score as 0.5 | 1,
            firstAdmin: s.firstAdmin,
            carriedForward: s.carriedForward,
          })),
          b.administrations.map((a) => ({
            adminNumber: a.adminNumber,
            label: `Admin ${a.adminNumber}${a.testDate ? ` (${toDay(a.testDate)})` : ""}`,
          })),
        )
      : null;
    const blockers = exportBlockers(checks);
    const catalog = assessmentCatalog();
    const assessmentOptions = newestFirst([
      ...b.assessments.map((a) => assessmentItem(catalog, b.client.id, a)),
      ...b.administrations.map((a) => vbmappItem(catalog, b.client.id, a)),
    ]).map((i) => ({
      id: i.id,
      typeName: [i.typeName, i.moduleName, i.formName].filter(Boolean).join(" · "),
      administeredOn: i.administeredOn,
      status: i.status,
      vbmapp: i.source === "vbmapp_import",
      selected: i.source === "vbmapp_import" || b.plan.assessmentIds.includes(i.id),
    }));
    return {
      bundle: b,
      assessmentOptions,
      sourced: sourced.values(),
      sections,
      goals,
      grid,
      checks,
      ruleResults: results,
      blockers,
      exportable: blockers.length === 0,
    };
  });
}

// ---------------------------------------------------------------- AI drafting

/** Sections being drafted right now (one app process): a retried request must not start a second draft. */
const draftsInFlight = new Set<string>();
export const DRAFT_IN_PROGRESS = "A draft for this section is already being written. It will appear shortly.";

export async function draftSection(ctx: OrgCtx, planId: string, key: string, asOf: Day) {
  requirePermission(ctx.role, "section:draft");
  const def = SECTION_BY_KEY.get(key);
  if (!def) throw new HttpError(404, "Unknown section");
  if (def.bcbaOnly) throw new HttpError(400, "This section is written by the BCBA");
  // Read everything in a short transaction; the model call (which can take most of a minute) runs
  // outside any transaction, and the result is written in a second one.
  const prep = await withOrg(ctx, async (tx) => {
    const b = await loadPlanBundle(tx, planId);
    const section = b.plan.sections.find((s) => s.key === key);
    if (!section) throw new HttpError(404, "Unknown section");
    assertOpen(section.state, "drafting again");
    const sourced = buildSourcedContext(b, asOf);
    const names = pseudonymNames(b.client);
    return {
      sectionId: section.id,
      content: section.content,
      sourced,
      payload: buildDraftPayload({ def, bundle: b, sourced, names }),
      identifiers: {
        names: [...names.client, ...names.others],
        dob: toDay(b.client.dob),
        memberIds: b.client.payors.map((p) => p.memberId),
      },
    };
  });
  if (draftsInFlight.has(prep.sectionId)) throw new HttpError(409, DRAFT_IN_PROGRESS);
  draftsInFlight.add(prep.sectionId);
  let result;
  try {
    result = await draftWithFirewall(null, {
      ctx,
      system: DRAFT_SYSTEM_PROMPT,
      payload: prep.payload,
      sourced: prep.sourced,
      identifiers: prep.identifiers,
      audit: { entityType: "PlanSection", entityId: prep.sectionId, section: def.key, task: "draft_section" },
    });
  } finally {
    draftsInFlight.delete(prep.sectionId);
  }
  const text = tidyDraft(result.text);
  return withOrg(ctx, async (tx) => {
    // The BCBA may have approved or edited the section while the model was writing: never overwrite that.
    const current = await tx.planSection.findUniqueOrThrow({ where: { id: prep.sectionId } });
    assertOpen(current.state, "drafting again");
    if (current.content !== prep.content)
      throw new HttpError(
        409,
        "The section changed while the AI was writing, so the new draft was not saved. Your text is kept.",
      );
    await tx.planSection.update({
      where: { id: prep.sectionId },
      data: {
        aiDraft: text,
        content: text,
        state: "draft",
        approvedAt: null,
        approvedById: null,
        redraftReason: null,
      },
    });
    await tx.planSectionRevision.create({
      data: {
        orgId: ctx.orgId,
        sectionId: prep.sectionId,
        kind: "ai_draft",
        content: text,
        userId: ctx.userId,
      },
    });
    // The rendered draft lets the page show it before its refresh lands.
    return { text, html: renderTokens(text, prep.sourced, "html"), attempts: result.attempts };
  });
}

// ---------------------------------------------------------------- edit / items / approve

function assertOpen(state: string, doing: string) {
  if (state === "approved") throw new HttpError(409, `Section is approved. Reopen it before ${doing}.`);
  if (state === "not_applicable")
    throw new HttpError(409, `Section is marked not applicable. Reopen it before ${doing}.`);
}

export async function editSection(ctx: OrgCtx, planId: string, key: string, content: string, asOf: Day) {
  requirePermission(ctx.role, "section:edit");
  return withOrg(ctx, async (tx) => {
    const b = await loadPlanBundle(tx, planId);
    const section = b.plan.sections.find((s) => s.key === key);
    if (!section) throw new HttpError(404, "Unknown section");
    assertOpen(section.state, "editing");
    const v = validateBcbaText(content, buildSourcedContext(b, asOf));
    if (!v.ok)
      throw new HttpError(
        422,
        `Unknown or malformed value references: ${v.errors.map((e) => e.detail).join(", ")}`,
      );
    await tx.planSection.update({
      where: { id: section.id },
      // The BCBA rewrote the text, so a pending redraft flag is answered.
      data: { content: v.normalized, state: "edited", redraftReason: null },
    });
    await tx.planSectionRevision.create({
      data: {
        orgId: ctx.orgId,
        sectionId: section.id,
        kind: "edit",
        content: v.normalized,
        diff: lineDiff(section.aiDraft ?? "", v.normalized),
        userId: ctx.userId,
      },
    });
    return { unsourcedNumbers: v.unsourcedNumbers };
  });
}

export async function setSectionItem(
  ctx: OrgCtx,
  planId: string,
  key: string,
  itemKey: string,
  status: "answered" | "none" | null,
  note?: string,
) {
  requirePermission(ctx.role, "section:edit");
  return withOrg(ctx, async (tx) => {
    const section = await tx.planSection.findUniqueOrThrow({ where: { planId_key: { planId, key } } });
    assertOpen(section.state, "changing items");
    const items = { ...((section.items ?? {}) as Record<string, ItemState>) };
    if (status === null) delete items[itemKey];
    else items[itemKey] = { status, ...(note ? { note } : {}) };
    await tx.planSection.update({
      where: { id: section.id },
      data: { items: items as Prisma.InputJsonValue },
    });
  });
}

export async function approveSection(ctx: OrgCtx, planId: string, key: string, asOf: Day) {
  requirePermission(ctx.role, "section:approve");
  return withOrg(ctx, async (tx) => {
    const b = await loadPlanBundle(tx, planId);
    const section = b.plan.sections.find((s) => s.key === key);
    if (!section) throw new HttpError(404, "Unknown section");
    if (section.state === "approved") return section;
    assertOpen(section.state, "approving");
    const problems: string[] = [];
    if (section.redraftReason)
      problems.push(`${section.redraftReason} Redraft it with AI or edit it before approving`);
    if (!section.content.trim()) problems.push("Section has no content");
    const v = validateBcbaText(section.content, buildSourcedContext(b, asOf));
    if (!v.ok) problems.push(`Invalid value references: ${v.errors.map((e) => e.detail).join(", ")}`);
    const ph = unresolvedPlaceholders(section.content);
    if (ph.length) problems.push(`Unresolved placeholders: ${ph.join(", ")}`);
    const rules = await primaryRules(tx, b);
    const items = requiredItemsFor(
      key,
      b.plan.type,
      (b.intake?.answers ?? {}) as IntakeAnswers,
      rules,
      (section.items ?? {}) as Record<string, ItemState>,
      b.plan.sections.map((x) => x.key),
    );
    const open = items.filter((i) => i.status === null);
    if (open.length)
      problems.push(`Required items not answered or marked none: ${open.map((i) => i.label).join("; ")}`);
    if (problems.length) throw new HttpError(422, problems.join(". "));
    const updated = await tx.planSection.update({
      where: { id: section.id },
      data: { state: "approved", approvedById: ctx.userId, approvedAt: new Date() },
    });
    await tx.planSectionRevision.create({
      data: {
        orgId: ctx.orgId,
        sectionId: section.id,
        kind: "approve",
        content: section.content,
        diff: lineDiff(section.aiDraft ?? "", section.content),
        userId: ctx.userId,
      },
    });
    await audit(tx, {
      action: "section:approve",
      entityType: "PlanSection",
      entityId: section.id,
      meta: { planId, key, contentHash: sha256(section.content) },
    });
    return updated;
  });
}

/** Where the BCBA's reason for "not applicable" is kept on the section. */
export const NOT_APPLICABLE_ITEM = "_not_applicable";

/** A conditional section (group, school, telehealth) that does not apply to this request. BCBA only. */
export async function markSectionNotApplicable(ctx: OrgCtx, planId: string, key: string, reason: string) {
  requirePermission(ctx.role, "section:approve");
  const def: SectionDef | undefined = SECTION_BY_KEY.get(key);
  if (!def?.condition) throw new HttpError(422, "Only conditional sections can be marked not applicable");
  const why = reason.trim();
  if (!why) throw new HttpError(422, "Say why this section does not apply");
  return withOrg(ctx, async (tx) => {
    const section = await tx.planSection.findUniqueOrThrow({ where: { planId_key: { planId, key } } });
    if (section.state === "not_applicable") return section;
    if (section.state === "approved")
      throw new HttpError(409, "Section is approved. Reopen it before marking it not applicable.");
    const updated = await tx.planSection.update({
      where: { id: section.id },
      data: {
        state: "not_applicable",
        approvedById: ctx.userId,
        approvedAt: new Date(),
        items: {
          ...((section.items ?? {}) as Record<string, ItemState>),
          [NOT_APPLICABLE_ITEM]: { status: "answered", note: why.slice(0, 500) },
        } as Prisma.InputJsonValue,
      },
    });
    await tx.planSectionRevision.create({
      data: {
        orgId: ctx.orgId,
        sectionId: section.id,
        kind: "not_applicable",
        content: section.content,
        userId: ctx.userId,
      },
    });
    await audit(tx, {
      action: "section:not_applicable",
      entityType: "PlanSection",
      entityId: section.id,
      meta: { planId, key },
    });
    return updated;
  });
}

export async function reopenSection(ctx: OrgCtx, planId: string, key: string) {
  requirePermission(ctx.role, "section:approve");
  return withOrg(ctx, async (tx) => {
    const section = await tx.planSection.findUniqueOrThrow({ where: { planId_key: { planId, key } } });
    const items = { ...((section.items ?? {}) as Record<string, ItemState>) };
    delete items[NOT_APPLICABLE_ITEM];
    await tx.planSection.update({
      where: { id: section.id },
      data: {
        // Untouched AI text stays a draft: "edited" means the BCBA changed it.
        state:
          !section.content.trim() || (section.aiDraft !== null && section.content === section.aiDraft)
            ? "draft"
            : "edited",
        approvedAt: null,
        approvedById: null,
        items: items as Prisma.InputJsonValue,
      },
    });
    await tx.planSectionRevision.create({
      data: {
        orgId: ctx.orgId,
        sectionId: section.id,
        kind: "reopen",
        content: section.content,
        userId: ctx.userId,
      },
    });
    await audit(tx, { action: "section:reopen", entityType: "PlanSection", entityId: section.id });
  });
}

// ---------------------------------------------------------------- assessments used

/**
 * The assessments this plan uses (assessment ids; verified VB-MAPP administrations are always
 * used). A change flags each section that drew on assessments for a redraft and reopens it if it
 * was approved. Nothing is approved automatically.
 */
export async function setPlanAssessments(ctx: OrgCtx, planId: string, ids: string[]) {
  requirePermission(ctx.role, "section:edit");
  return withOrg(ctx, async (tx) => {
    const plan = await tx.plan.findUnique({ where: { id: planId }, include: { sections: true } });
    if (!plan) throw new HttpError(404, "Not found");
    if (plan.status === "finalized")
      throw new HttpError(409, "This plan is finalized; its assessments can no longer change");
    const wanted = [...new Set(ids)];
    const found = await tx.assessment.findMany({
      where: { id: { in: wanted }, clientId: plan.clientId },
      select: { id: true, administeredOn: true },
      orderBy: [{ administeredOn: "asc" }, { id: "asc" }],
    });
    if (found.length !== wanted.length) throw new HttpError(422, "Choose assessments of this client");
    const next = found.map((a) => a.id);
    if (sameSelection(plan.assessmentIds, next)) return { changed: false, redraft: [] as string[] };
    await tx.plan.update({ where: { id: planId }, data: { assessmentIds: next } });
    const marks = await markForRedraft(tx, ctx, plan.sections);
    await audit(tx, {
      action: "plan:assessments",
      entityType: "Plan",
      entityId: planId,
      meta: {
        added: next.filter((x) => !plan.assessmentIds.includes(x)).length,
        removed: plan.assessmentIds.filter((x) => !next.includes(x)).length,
        redraft: marks.map((m) => m.key),
      },
    });
    return { changed: true, redraft: marks.map((m) => m.key) };
  });
}

/** Flags sections that use assessments for a redraft; approved ones are reopened. */
export async function markForRedraft(
  tx: Tx,
  ctx: OrgCtx,
  sections: { id: string; key: string; state: string; content: string; aiDraft: string | null }[],
) {
  const marks = redraftMarks(sections);
  for (const m of marks) {
    const s = sections.find((x) => x.key === m.key)!;
    await tx.planSection.update({
      where: { id: s.id },
      data: {
        redraftReason: REDRAFT_REASON,
        state: m.state,
        ...(m.reopened ? { approvedAt: null, approvedById: null } : {}),
      },
    });
    if (m.reopened) {
      await tx.planSectionRevision.create({
        data: { orgId: ctx.orgId, sectionId: s.id, kind: "reopen", content: s.content, userId: ctx.userId },
      });
      await audit(tx, {
        action: "section:reopen",
        entityType: "PlanSection",
        entityId: s.id,
        meta: { reason: "assessments_changed" },
      });
    }
  }
  return marks;
}

/**
 * After an assessment is confirmed: plans that selected it (as a draft) now have its scores, and
 * a confirmed administration dated before others of its series renumbers their tokens. Either
 * way, open plans that use the series get their assessment sections flagged for a redraft.
 */
export async function afterAssessmentConfirmed(tx: Tx, ctx: OrgCtx, assessmentId: string) {
  const a = await tx.assessment.findUniqueOrThrow({ where: { id: assessmentId } });
  const catalog = assessmentCatalog();
  const series = seriesKey(catalog, a);
  const sameSeries = (
    await tx.assessment.findMany({ where: { clientId: a.clientId, typeKey: a.typeKey, status: "confirmed" } })
  ).filter((x) => seriesKey(catalog, x) === series);
  const renumbers = sameSeries.some((x) => x.id !== a.id && x.administeredOn > a.administeredOn);
  const plans = await tx.plan.findMany({
    where: { clientId: a.clientId, status: { not: "finalized" } },
    include: { sections: true },
  });
  for (const p of plans) {
    const affected =
      p.assessmentIds.includes(a.id) || (renumbers && sameSeries.some((x) => p.assessmentIds.includes(x.id)));
    if (affected) await markForRedraft(tx, ctx, p.sections);
  }
}

/** A deleted draft leaves every plan's selection. */
export async function dropFromPlanSelections(tx: Tx, clientId: string, assessmentId: string) {
  const plans = await tx.plan.findMany({
    where: { clientId, assessmentIds: { has: assessmentId } },
    select: { id: true, assessmentIds: true },
  });
  for (const p of plans)
    await tx.plan.update({
      where: { id: p.id },
      data: { assessmentIds: p.assessmentIds.filter((x) => x !== assessmentId) },
    });
}

// ---------------------------------------------------------------- goals

export async function approveGoal(ctx: OrgCtx, goalId: string) {
  requirePermission(ctx.role, "goal:approve");
  return withOrg(ctx, async (tx) => {
    const g = await tx.goal.findUniqueOrThrow({ where: { id: goalId } });
    const ph = unresolvedPlaceholders(g.objective, g.rationale, g.sd, g.targetBehavior);
    if (ph.length) throw new HttpError(422, `Goal has unresolved placeholders: ${ph.join(", ")}`);
    await tx.goal.update({
      where: { id: goalId },
      data: { status: "approved", approvedById: ctx.userId, approvedAt: new Date() },
    });
    await audit(tx, { action: "goal:approve", entityType: "Goal", entityId: goalId });
  });
}

export async function updateGoal(
  ctx: OrgCtx,
  goalId: string,
  data: {
    objective?: string;
    rationale?: string;
    flatExplanation?: string | null;
    masteryAccuracyPct?: number;
    masteryConsecutiveSessions?: number;
    masteryInstructors?: number;
    introducedAt?: Day | null;
    projectedMasteryDate?: Day | null;
    progressStatus?: GoalStatus;
    barriers?: string;
    settings?: string[];
  },
) {
  requirePermission(ctx.role, "goal:write");
  return withOrg(ctx, async (tx) => {
    // Changing what the goal says (including its dates) sends it back for approval;
    // status, barriers, settings, and a flat-progress explanation do not.
    const changesContent = [
      "objective",
      "rationale",
      "masteryAccuracyPct",
      "masteryConsecutiveSessions",
      "masteryInstructors",
      "introducedAt",
      "projectedMasteryDate",
    ].some((k) => k in data);
    const day = (d: Day | null | undefined) =>
      d === undefined ? undefined : d === null ? null : new Date(`${d}T00:00:00Z`);
    const { introducedAt, projectedMasteryDate, ...rest } = data;
    const intro = day(introducedAt);
    const projected = day(projectedMasteryDate);
    if (intro !== undefined || projected !== undefined) {
      const g = await tx.goal.findUniqueOrThrow({ where: { id: goalId } });
      const i = intro === undefined ? g.introducedAt : intro;
      const pm = projected === undefined ? g.projectedMasteryDate : projected;
      if (i && pm && pm < i)
        throw new HttpError(422, "Projected mastery cannot be before the date introduced");
    }
    await tx.goal.update({
      where: { id: goalId },
      data: {
        ...rest,
        ...(intro !== undefined ? { introducedAt: intro } : {}),
        ...(projected !== undefined ? { projectedMasteryDate: projected } : {}),
        ...(changesContent ? { status: "draft", approvedAt: null, approvedById: null } : {}),
      },
    });
    await audit(tx, {
      action: "goal:update",
      entityType: "Goal",
      entityId: goalId,
      meta: { fields: Object.keys(data) },
    });
  });
}

/**
 * Lock a goal's baseline: the mean of its first three data points, dated by the
 * third. Computed from the goal's own records and permanent once locked (a
 * database trigger refuses any change).
 */
export async function lockGoalBaseline(ctx: OrgCtx, goalId: string) {
  requirePermission(ctx.role, "goal:approve");
  return withOrg(ctx, async (tx) => {
    const g = await tx.goal.findUniqueOrThrow({
      where: { id: goalId },
      include: { dataPoints: { orderBy: { date: "asc" } } },
    });
    if (g.baselineLockedAt) throw new HttpError(409, "This goal's baseline is already locked");
    const pts = g.dataPoints.map((p) => ({ date: toDay(p.date), value: p.value }));
    const value = baseline(pts);
    if (value === null || pts.length < BASELINE_POINTS)
      throw new HttpError(422, "Record at least three data points before locking the baseline");
    const date = pts[BASELINE_POINTS - 1]!.date;
    // Conditional update: a concurrent lock makes this match nothing (409), never trips the trigger.
    const r = await tx.goal.updateMany({
      where: { id: goalId, baselineLockedAt: null },
      data: {
        baselineValue: value,
        baselineDate: new Date(`${date}T00:00:00Z`),
        baselineLockedAt: new Date(),
        baselineLockedById: ctx.userId,
      },
    });
    if (r.count === 0) throw new HttpError(409, "This goal's baseline is already locked");
    await audit(tx, { action: "goal:lock_baseline", entityType: "Goal", entityId: goalId, meta: { date } });
    return { value, date };
  });
}

// ---------------------------------------------------------------- packet / export gate

export async function assertExportable(
  tx: Tx,
  planId: string,
  asOf: Day,
): Promise<{ bundle: PlanBundle; results: RuleResult[] }> {
  const b = await loadPlanBundle(tx, planId);
  const sourced = buildSourcedContext(b, asOf);
  const { results, scope } = await evaluateClientRules(tx, b.client.id, asOf, planId);
  const blockers = exportBlockers(runPresubmissionAudit(b, sourced, results, asOf, scope));
  const unapproved = b.plan.sections.filter((s) => !sectionDone(s.state));
  if (unapproved.length || blockers.length)
    throw new HttpError(
      409,
      `Export blocked: ${unapproved.length} section(s) not approved; ${blockers.length} audit check(s) failing`,
    );
  return { bundle: b, results };
}
