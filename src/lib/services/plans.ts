/**
 * Treatment plan builder. Section workflow: draft → edited → approved, one
 * section at a time, BCBA only. There is intentionally no "approve all".
 */
import type { Prisma } from "@prisma/client";
import { draftWithFirewall } from "../ai";
import { assessmentCatalog } from "../assessments/catalog";
import {
  assessmentWindow,
  assessmentWindowLabel,
  assessmentWindowStart,
  defaultAssessmentSelection,
  redraftMarks,
  REDRAFT_REASON,
  nextSeriesNumber,
  sameSelection,
} from "../assessments/plan";
import { assessmentItem, newestFirst, vbmappItem } from "../assessments/view";
import { audit, sha256 } from "../audit";
import { withOrg, type OrgCtx, type Tx } from "../db";
import { toDay, type Day } from "../dates";
import { renderTokens, validateBcbaText } from "../firewall";
import { unresolvedPlaceholders } from "../goals/checks";
import {
  GOAL_APPROVED_FIELDS,
  GOAL_CHANGED_BEFORE_APPROVAL,
  GOAL_CHANGED_ELSEWHERE,
  storedGoalValues,
  type ApprovedGoalValues,
  type GoalPatch,
} from "../goals/goal-patch";
import { goalNames } from "../goals/names";
import { REMOVED_GOAL_PLACEHOLDER, goalTokenOrdinals, renumberGoalTokens } from "../goals/renumber";
import { pseudonymNames } from "../intake/derive";
import { INTAKE_FIELDS, isNa, type IntakeAnswers } from "../intake/schema";
import { HttpError } from "../log";
import { requirePermission } from "../permissions";
import { buildSourcedContext, loadPlanBundle, type PlanBundle } from "../plan/context";
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
import { assertClientActive, assertGoalClientActive, assertPlanClientActive } from "./client-status";

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

/** The confirmed assessments of a client given in the `months` before `anchor` (the default selection). */
async function defaultSelectionFor(tx: Tx, clientId: string, anchor: Day, months: number) {
  const assessments = await tx.assessment.findMany({
    where: { clientId },
    select: { id: true, status: true, administeredOn: true },
  });
  return defaultAssessmentSelection(assessments, assessmentWindowStart(anchor, months));
}

export async function createPlan(ctx: OrgCtx, clientId: string, type: "initial" | "reauth") {
  requirePermission(ctx.role, "plan:create");
  return withOrg(ctx, async (tx) => {
    await assertClientActive(tx, clientId);
    const client = await tx.client.findUniqueOrThrow({
      where: { id: clientId },
      include: { payors: true, authorizations: { orderBy: { endDate: "desc" }, take: 1 } },
    });
    const primary = client.payors.find((p) => p.priority === "primary");
    const rules = primary ? await loadApplicableRules(tx, primary) : [];
    // Default assessments: confirmed ones from the window (six months, or the payor's own rule).
    const window = assessmentWindow(rules);
    const assessmentIds = await defaultSelectionFor(tx, clientId, toDay(new Date()), window.months);
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
      meta: {
        type,
        assessments: assessmentIds.length,
        windowMonths: window.months,
        windowRule: window.rule?.id ?? null,
      },
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
    // Goals are named, never numbered, in what readers see.
    const names = goalNames(b.goals);
    const goals = b.goals.map((g) => ({
      ...g,
      name: names.get(g.id)!,
      objectiveHtml: render(g.objective),
      rationaleHtml: render(g.rationale),
      placeholders: unresolvedPlaceholders(g.objective, g.rationale),
      graph: goalGraphSvg({
        title: names.get(g.id)!,
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
    // Where a reset (and a new plan) takes its default selection from.
    const window = assessmentWindow(rules);
    return {
      bundle: b,
      assessmentOptions,
      assessmentWindow: { ...window, label: assessmentWindowLabel(window) },
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

/** The client's goals and their numbers, to tell whether they changed between two reads. */
function goalNumbering(goals: { id: string; ordinal: number }[]): string {
  return goals
    .map((g) => `${g.ordinal}:${g.id}`)
    .sort()
    .join(",");
}

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
    await assertPlanClientActive(tx, planId);
    const b = await loadPlanBundle(tx, planId);
    const section = b.plan.sections.find((s) => s.key === key);
    if (!section) throw new HttpError(404, "Unknown section");
    assertOpen(section.state, "drafting again");
    const sourced = buildSourcedContext(b, asOf);
    const names = pseudonymNames(b.client);
    return {
      sectionId: section.id,
      content: section.content,
      clientId: b.client.id,
      goalNumbering: goalNumbering(b.goals),
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
    // The client may have been marked inactive while the model was writing: drop the draft then too.
    await assertPlanClientActive(tx, planId);
    // The BCBA may have approved or edited the section while the model was writing: never overwrite that.
    const current = await tx.planSection.findUniqueOrThrow({ where: { id: prep.sectionId } });
    assertOpen(current.state, "drafting again");
    if (current.content !== prep.content)
      throw new HttpError(
        409,
        "The section changed while the AI was writing, so the new draft was not saved. Your text is kept.",
      );
    // The draft refers to goals by number: if goals were removed or renumbered meanwhile, its
    // {{goal.N.*}} references would point at different goals.
    const goalsNow = await tx.goal.findMany({
      where: { clientId: prep.clientId },
      select: { id: true, ordinal: true },
    });
    if (goalNumbering(goalsNow) !== prep.goalNumbering)
      throw new HttpError(
        409,
        "The client's goals changed while the AI was writing, so the new draft was not saved. Draft it again.",
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

/** The redraft reason a section gets when a goal it covered is removed. */
export const GOAL_REMOVED_REDRAFT_REASON = "A goal this section covered was removed after it was written.";

function assertOpen(state: string, doing: string) {
  if (state === "approved") throw new HttpError(409, `Section is approved. Reopen it before ${doing}.`);
  if (state === "not_applicable")
    throw new HttpError(409, `Section is marked not applicable. Reopen it before ${doing}.`);
}

export async function editSection(ctx: OrgCtx, planId: string, key: string, content: string, asOf: Day) {
  requirePermission(ctx.role, "section:edit");
  return withOrg(ctx, async (tx) => {
    await assertPlanClientActive(tx, planId);
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
  // Keys starting with "_" are the app's own marks (not applicable, needs redraft): they change
  // only through their own actions, never through the checklist.
  if (itemKey.startsWith("_")) throw new HttpError(422, "That item cannot be changed here");
  return withOrg(ctx, async (tx) => {
    await assertPlanClientActive(tx, planId);
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
    await assertPlanClientActive(tx, planId);
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
    await assertPlanClientActive(tx, planId);
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
    await assertPlanClientActive(tx, planId);
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
 * used). A change among the confirmed ones flags each section that drew on assessments for a
 * redraft and reopens it if it was approved. Nothing is approved automatically.
 */
export async function setPlanAssessments(ctx: OrgCtx, planId: string, ids: string[]) {
  requirePermission(ctx.role, "section:edit");
  return withOrg(ctx, async (tx) => {
    const plan = await editablePlanForAssessments(tx, planId);
    return applyPlanAssessments(tx, ctx, plan, ids, "plan:assessments", {});
  });
}

async function editablePlanForAssessments(tx: Tx, planId: string) {
  await assertPlanClientActive(tx, planId);
  const plan = await tx.plan.findUnique({ where: { id: planId }, include: { sections: true } });
  if (!plan) throw new HttpError(404, "Not found");
  if (plan.status === "finalized")
    throw new HttpError(409, "This plan is finalized; its assessments can no longer change");
  return plan;
}

/**
 * "Reset to default": the selection a new plan would get, from the window in force now (six
 * months, or the primary payor's assessment_window rule) counted back from the plan's creation
 * date. Flags sections for a redraft like any other change. Existing plans keep their stored
 * selection until a BCBA resets it.
 */
export async function resetPlanAssessments(ctx: OrgCtx, planId: string) {
  requirePermission(ctx.role, "section:edit");
  return withOrg(ctx, async (tx) => {
    const plan = await editablePlanForAssessments(tx, planId);
    const client = await tx.client.findUniqueOrThrow({
      where: { id: plan.clientId },
      include: { payors: true },
    });
    const primary = client.payors.find((p) => p.priority === "primary");
    const window = assessmentWindow(primary ? await loadApplicableRules(tx, primary) : []);
    const ids = await defaultSelectionFor(tx, plan.clientId, toDay(plan.createdAt), window.months);
    return applyPlanAssessments(tx, ctx, plan, ids, "plan:assessments_reset", {
      windowMonths: window.months,
      windowRule: window.rule?.id ?? null,
    });
  });
}

async function applyPlanAssessments(
  tx: Tx,
  ctx: OrgCtx,
  plan: Prisma.PlanGetPayload<{ include: { sections: true } }>,
  ids: string[],
  action: string,
  extraMeta: Record<string, string | number | null>,
) {
  const planId = plan.id;
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
  // Drafts give no values, so only a change among the confirmed ones reopens sections (a
  // selected draft flags them when it is confirmed).
  const confirmed = new Set(
    (
      await tx.assessment.findMany({
        where: { id: { in: [...new Set([...plan.assessmentIds, ...next])] }, status: "confirmed" },
        select: { id: true },
      })
    ).map((a) => a.id),
  );
  const usedChanged = !sameSelection(
    plan.assessmentIds.filter((x) => confirmed.has(x)),
    next.filter((x) => confirmed.has(x)),
  );
  const marks = usedChanged ? await markForRedraft(tx, ctx, plan.sections) : [];
  await audit(tx, {
    action,
    entityType: "Plan",
    entityId: planId,
    meta: {
      added: next.filter((x) => !plan.assessmentIds.includes(x)).length,
      removed: plan.assessmentIds.filter((x) => !next.includes(x)).length,
      redraft: marks.map((m) => m.key),
      ...extraMeta,
    },
  });
  return { changed: true, redraft: marks.map((m) => m.key) };
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
 * Stores the token number of an assessment that was just confirmed: the next one in its series,
 * never reused or reassigned (a back-dated administration does not renumber the others). Rows
 * confirmed before numbers were stored get theirs first, as they already read. A per-client
 * lock keeps two confirms at once from taking the same number.
 */
export async function storeSeriesNumber(tx: Tx, assessmentId: string) {
  const a = await tx.assessment.findUniqueOrThrow({ where: { id: assessmentId }, include: { scores: true } });
  if (a.status !== "confirmed" || a.seriesNumber !== null) return;
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`assessment-series:${a.clientId}`}::text))`;
  const others = await tx.assessment.findMany({
    where: { clientId: a.clientId, status: "confirmed", id: { not: a.id } },
    include: { scores: true },
  });
  const { series, n, backfill } = nextSeriesNumber(assessmentCatalog(), others, a);
  for (const b of backfill)
    await tx.assessment.update({ where: { id: b.id }, data: { seriesKey: b.series, seriesNumber: b.n } });
  await tx.assessment.update({ where: { id: a.id }, data: { seriesKey: series, seriesNumber: n } });
}

/**
 * After an assessment is confirmed: its token number is stored, and open plans that selected it
 * (as a draft) now have its scores, so their assessment sections are flagged for a redraft.
 * Token numbers never shift, so no other plan, and no finalized plan, changes.
 */
export async function afterAssessmentConfirmed(tx: Tx, ctx: OrgCtx, assessmentId: string) {
  await storeSeriesNumber(tx, assessmentId);
  const a = await tx.assessment.findUniqueOrThrow({
    where: { id: assessmentId },
    select: { clientId: true },
  });
  const plans = await tx.plan.findMany({
    where: { clientId: a.clientId, status: { not: "finalized" }, assessmentIds: { has: assessmentId } },
    include: { sections: true },
  });
  for (const p of plans) await markForRedraft(tx, ctx, p.sections);
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

/** Lock the goal's row for this transaction, so saves and approvals of one goal never interleave. */
async function lockGoalRow(tx: Tx, goalId: string) {
  await tx.$queryRaw`SELECT 1 FROM goal WHERE id = ${goalId}::uuid FOR UPDATE`;
}

const sameValue = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/**
 * Approve a goal. `expected` is what the approver was shown (its wording, mastery criteria, and
 * dates): if the goal now says anything else (an autosave from another tab or person landed
 * meanwhile), nothing is approved (409), so text nobody reviewed is never approved.
 */
export async function approveGoal(ctx: OrgCtx, goalId: string, opts: { expected?: ApprovedGoalValues } = {}) {
  requirePermission(ctx.role, "goal:approve");
  return withOrg(ctx, async (tx) => {
    await assertGoalClientActive(tx, goalId);
    await lockGoalRow(tx, goalId);
    const g = await tx.goal.findUniqueOrThrow({ where: { id: goalId } });
    if (opts.expected) {
      const now = storedGoalValues(g);
      if (GOAL_APPROVED_FIELDS.some((k) => !sameValue(now[k], opts.expected![k])))
        throw new HttpError(409, GOAL_CHANGED_BEFORE_APPROVAL);
    }
    const ph = unresolvedPlaceholders(g.objective, g.rationale, g.sd, g.targetBehavior);
    if (ph.length) throw new HttpError(422, `Goal has unresolved placeholders: ${ph.join(", ")}`);
    const saved = await tx.goal.update({
      where: { id: goalId },
      data: { status: "approved", approvedById: ctx.userId, approvedAt: new Date() },
    });
    await audit(tx, { action: "goal:approve", entityType: "Goal", entityId: goalId });
    return { updatedAt: saved.updatedAt.toISOString() };
  });
}

export type GoalSaveResult = {
  /** The goal's new version, for the editor's next save. */
  updatedAt: string;
  status: string;
  /** The save changed what an approved goal says, so it went back to draft for approval. */
  returnedToDraft: boolean;
};

export async function updateGoal(
  ctx: OrgCtx,
  goalId: string,
  data: GoalPatch,
  opts: { base?: Record<string, unknown>; baseAlt?: Record<string, unknown> } = {},
): Promise<GoalSaveResult> {
  requirePermission(ctx.role, "goal:write");
  if (data.progressStatus === "discontinued")
    throw new HttpError(422, "Use Discontinue in the goal's menu: it records the date and your reason.");
  return withOrg(ctx, async (tx) => {
    await assertGoalClientActive(tx, goalId);
    await lockGoalRow(tx, goalId);
    const cur = await tx.goal.findUniqueOrThrow({ where: { id: goalId } });
    // Per-field optimistic concurrency: an editor names the value each field held when it was
    // edited. Only a field someone else changed meanwhile conflicts (a field already holding the
    // new value does not); changes to other fields, or to the goal's position, plan, approval, or
    // baseline, never do. Nothing is saved on a conflict; the editor gets the current values.
    if (opts.base) {
      const now = storedGoalValues(cur);
      const sent = Object.keys(data) as (keyof typeof now)[];
      const conflicts = sent.filter(
        (k) =>
          Object.hasOwn(opts.base!, k) &&
          !sameValue(now[k], opts.base![k]) &&
          !(opts.baseAlt && Object.hasOwn(opts.baseAlt, k) && sameValue(now[k], opts.baseAlt[k])) &&
          !sameValue(now[k], data[k]),
      );
      if (conflicts.length)
        throw new HttpError(409, GOAL_CHANGED_ELSEWHERE, undefined, {
          conflict: {
            fields: conflicts,
            current: Object.fromEntries(sent.map((k) => [k, now[k]])),
            updatedAt: cur.updatedAt.toISOString(),
          },
        });
    }
    if (data.progressStatus !== undefined && cur.progressStatus === "discontinued")
      throw new HttpError(422, "This goal is discontinued. Use Resume in the goal's menu first.");
    // Changing what the goal says (including its dates) sends it back for approval;
    // status, barriers, settings, and a flat-progress explanation do not. Only real changes count.
    const day = (d: Day | null | undefined) =>
      d === undefined ? undefined : d === null ? null : new Date(`${d}T00:00:00Z`);
    const { introducedAt, projectedMasteryDate, ...rest } = data;
    const intro = day(introducedAt);
    const projected = day(projectedMasteryDate);
    const sameDay = (a: Date | null, b: Date | null | undefined) =>
      b === undefined || (a === null ? b === null : b !== null && a.getTime() === b.getTime());
    const changesContent =
      (
        [
          "objective",
          "rationale",
          "masteryAccuracyPct",
          "masteryConsecutiveSessions",
          "masteryInstructors",
        ] as const
      ).some((k) => data[k] !== undefined && data[k] !== cur[k]) ||
      !sameDay(cur.introducedAt, intro) ||
      !sameDay(cur.projectedMasteryDate, projected);
    if (intro !== undefined || projected !== undefined) {
      const i = intro === undefined ? cur.introducedAt : intro;
      const pm = projected === undefined ? cur.projectedMasteryDate : projected;
      if (i && pm && pm < i)
        throw new HttpError(422, "Projected mastery cannot be before the date introduced");
      if (intro && cur.discontinuedOn && intro > cur.discontinuedOn)
        throw new HttpError(422, "The date introduced cannot be after the date discontinued");
    }
    const returnedToDraft = changesContent && cur.status === "approved";
    // Guarded on the version read above, so two saves never interleave.
    const r = await tx.goal.updateMany({
      where: { id: goalId, updatedAt: cur.updatedAt },
      data: {
        ...rest,
        ...(intro !== undefined ? { introducedAt: intro } : {}),
        ...(projected !== undefined ? { projectedMasteryDate: projected } : {}),
        ...(changesContent ? { status: "draft", approvedAt: null, approvedById: null } : {}),
      },
    });
    if (r.count !== 1) throw new HttpError(409, GOAL_CHANGED_ELSEWHERE);
    const saved = await tx.goal.findUniqueOrThrow({
      where: { id: goalId },
      select: { updatedAt: true, status: true },
    });
    // One row per save (the editors debounce typing), with field names only: never goal text.
    await audit(tx, {
      action: "goal:update",
      entityType: "Goal",
      entityId: goalId,
      meta: { fields: Object.keys(data), ...(returnedToDraft ? { returnedToDraft: true } : {}) },
    });
    return { updatedAt: saved.updatedAt.toISOString(), status: saved.status, returnedToDraft };
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
    await assertGoalClientActive(tx, goalId);
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
    const { updatedAt } = await tx.goal.findUniqueOrThrow({
      where: { id: goalId },
      select: { updatedAt: true },
    });
    // The goal's new version, so the page's autosave moves to it.
    return { value, date, updatedAt: updatedAt.toISOString() };
  });
}

// ---------------------------------------------------------------- remove / discontinue

/** What decides whether a goal can be removed: the client's goals and plans, with section history. */
export async function loadGoalRemovalContext(tx: Tx, clientId: string) {
  const goals = await tx.goal.findMany({
    where: { clientId },
    include: { _count: { select: { dataPoints: true } } },
    orderBy: { ordinal: "asc" },
  });
  const plans = await tx.plan.findMany({
    where: { clientId },
    include: {
      packet: true,
      sections: { include: { revisions: { select: { kind: true, createdAt: true } } } },
    },
  });
  return { goals, plans };
}
type GoalRemovalContext = Awaited<ReturnType<typeof loadGoalRemovalContext>>;
type RemovableGoal = GoalRemovalContext["goals"][number];

/** True when a section includes the goal: its drafting context takes the goal, or its text refers to it. */
function sectionCoversGoal(key: string, text: string, g: { ordinal: number; category: string }) {
  const def = SECTION_BY_KEY.get(key);
  const goalsFor = def?.context?.goals;
  return (
    goalsFor === true ||
    (Array.isArray(goalsFor) && goalsFor.includes(g.category)) ||
    !!def?.valuePrefixes.includes("goals.") ||
    goalTokenOrdinals(text).includes(g.ordinal) ||
    /\{\{\s*goals\./.test(text)
  );
}

const DISCONTINUE_INSTEAD = "Discontinue it instead.";
export const USED_IN_APPROVED_TEXT = `This goal is used in approved plan text. ${DISCONTINUE_INSTEAD}`;

/** The plan's packet was exported or submitted (at any time). */
function packetWentOut(pk: { status: string; exportedAt: Date | null; submittedAt: Date | null } | null) {
  return !!pk && (!!pk.exportedAt || !!pk.submittedAt || pk.status === "submitted");
}

/**
 * Why a goal cannot be removed, or null when it can: only a goal added by mistake (no data,
 * never approved, never in an approved section, a finalized plan, or an exported packet) can go.
 */
export function goalRemovalBlocker(goal: RemovableGoal, rc: GoalRemovalContext): string | null {
  if (goal._count.dataPoints > 0) return `This goal has data, so it can't be removed. ${DISCONTINUE_INSTEAD}`;
  if (goal.baselineLockedAt)
    return `This goal's baseline is locked, so it can't be removed. ${DISCONTINUE_INSTEAD}`;
  if (goal.status === "approved" || goal.approvedAt)
    return `This goal was approved, so it can't be removed. ${DISCONTINUE_INSTEAD}`;
  // Approved, finalized, or exported text that shows this goal's own values would change.
  for (const p of rc.plans) {
    const fixed = p.status === "finalized" || packetWentOut(p.packet);
    for (const s of p.sections)
      if ((fixed || s.state === "approved") && goalTokenOrdinals(s.content).includes(goal.ordinal))
        return USED_IN_APPROVED_TEXT;
  }
  const since = goal.createdAt;
  for (const p of rc.plans) {
    if (p.status === "finalized" && (!p.finalizedAt || p.finalizedAt >= since))
      return `This goal is in a finalized plan, so it can't be removed. ${DISCONTINUE_INSTEAD}`;
    const pk = p.packet;
    // Only a packet exported or submitted after the goal existed can have included it. A submitted
    // packet with no recorded time is treated as including it (the safe reading).
    if (
      pk &&
      ((pk.exportedAt && pk.exportedAt >= since) ||
        (pk.submittedAt && pk.submittedAt >= since) ||
        (pk.status === "submitted" && !pk.exportedAt && !pk.submittedAt))
    )
      return `This goal was in an exported packet, so it can't be removed. ${DISCONTINUE_INSTEAD}`;
    for (const s of p.sections) {
      if (!sectionCoversGoal(s.key, s.content, goal)) continue;
      const approvedWithGoal =
        s.revisions.some((r) => r.kind === "approve" && r.createdAt >= since) ||
        (s.state === "approved" && (!s.approvedAt || s.approvedAt >= since));
      if (approvedWithGoal)
        return `This goal is part of an approved plan section, so it can't be removed. ${DISCONTINUE_INSTEAD}`;
    }
  }
  return null;
}

/**
 * Remove a goal added by mistake. Later goals move down one. Goals are never numbered in what
 * readers see, so moving the value references ({{goal.4.x}} becomes {{goal.3.x}}) changes no
 * rendered text: approved sections are rewritten too and stay approved (a "goal_renumbered"
 * revision records it). Drafted sections that covered the removed goal are marked for redraft.
 */
export async function removeGoal(ctx: OrgCtx, goalId: string) {
  requirePermission(ctx.role, "goal:approve");
  return withOrg(ctx, async (tx) => {
    await assertGoalClientActive(tx, goalId);
    const { clientId } = await tx.goal.findUniqueOrThrow({
      where: { id: goalId },
      select: { clientId: true },
    });
    const rc = await loadGoalRemovalContext(tx, clientId);
    const goal = rc.goals.find((g) => g.id === goalId)!;
    const blocker = goalRemovalBlocker(goal, rc);
    if (blocker) throw new HttpError(409, blocker);
    const removed = goal.ordinal;

    // Sections not yet approved (open, or set aside as not applicable and restorable by reopening)
    // that were written while the goal existed, or that refer to it or a later goal by number.
    const toRedraft = rc.plans
      .filter((p) => p.status !== "finalized")
      .flatMap((p) => p.sections)
      .filter(
        (s) =>
          (s.state === "draft" || s.state === "edited" || s.state === "not_applicable") &&
          (s.content.trim() || s.aiDraft),
      )
      .filter((s) => {
        const text = `${s.content}\n${s.aiDraft ?? ""}`;
        return (
          goalTokenOrdinals(text).some((k) => k >= removed) ||
          (sectionCoversGoal(s.key, text, goal) &&
            s.revisions.some(
              (r) => (r.kind === "ai_draft" || r.kind === "edit") && r.createdAt >= goal.createdAt,
            ))
        );
      });

    await tx.goalPhaseChange.deleteMany({ where: { goalId } });
    await tx.goal.updateMany({
      where: { replacementForGoalId: goalId },
      data: { replacementForGoalId: null },
    });
    await tx.goal.delete({ where: { id: goalId } });

    const later = rc.goals.filter((g) => g.ordinal > removed);
    const re = (t: string) => renumberGoalTokens(t, removed);
    // Every remaining goal's text is renumbered, earlier goals included: any goal may refer to a
    // later one ({{goal.4.baseline_pct}}), and that reference must keep pointing at the same goal.
    for (const g of rc.goals.filter((x) => x.id !== goalId)) {
      const text = {
        objective: re(g.objective),
        rationale: re(g.rationale),
        sd: re(g.sd),
        targetBehavior: re(g.targetBehavior),
        generalization: re(g.generalization),
        barriers: re(g.barriers),
        flatExplanation: g.flatExplanation === null ? null : re(g.flatExplanation),
      };
      const textChanged = (Object.keys(text) as (keyof typeof text)[]).some((k) => text[k] !== g[k]);
      const moves = g.ordinal > removed;
      if (!moves && !textChanged) continue;
      // A goal whose text referred to the removed goal now holds a placeholder: it goes back for approval.
      const lostReference =
        textChanged && Object.values(text).some((t) => t?.includes(REMOVED_GOAL_PLACEHOLDER));
      await tx.goal.update({
        where: { id: g.id },
        data: {
          ...(moves ? { ordinal: g.ordinal - 1 } : {}),
          ...(textChanged ? text : {}),
          ...(lostReference ? { status: "draft", approvedAt: null, approvedById: null } : {}),
        },
      });
    }

    for (const s of toRedraft) {
      const content = re(s.content);
      const aiDraft = s.aiDraft === null ? null : re(s.aiDraft);
      // Guarded on the state and text read above: a section approved or edited in another tab
      // since then is never overwritten (approved text changes only through a reopen).
      const updated = await tx.planSection.updateMany({
        where: { id: s.id, state: s.state, content: s.content },
        data: {
          content,
          aiDraft,
          redraftReason: GOAL_REMOVED_REDRAFT_REASON,
        },
      });
      if (updated.count !== 1)
        throw new HttpError(
          409,
          "A plan section changed while the goal was being removed. Nothing was changed; try again.",
        );
      if (content !== s.content)
        await tx.planSectionRevision.create({
          data: {
            orgId: ctx.orgId,
            sectionId: s.id,
            kind: "goal_removed",
            content,
            diff: lineDiff(s.content, content),
            userId: ctx.userId,
          },
        });
    }
    // Everything else that refers to a later goal (approved sections, finalized plans): the same
    // goal records, renumbered. The blocker above guarantees none refers to the removed goal.
    const redrafted = new Set(toRedraft.map((s) => s.id));
    const toRenumber = rc.plans
      .flatMap((p) => p.sections)
      .filter(
        (s) =>
          !redrafted.has(s.id) &&
          goalTokenOrdinals(`${s.content}\n${s.aiDraft ?? ""}`).some((k) => k > removed),
      );
    for (const s of toRenumber) {
      const content = re(s.content);
      const aiDraft = s.aiDraft === null ? null : re(s.aiDraft);
      // (The stored AI draft is never shown as approved text; a reference to the removed goal there
      // becomes the placeholder, as in any draft.)
      if (content.includes(REMOVED_GOAL_PLACEHOLDER)) throw new HttpError(409, USED_IN_APPROVED_TEXT);
      // Guarded like the redraft above; the state, approval, and approver are left as they are.
      const updated = await tx.planSection.updateMany({
        where: { id: s.id, state: s.state, content: s.content },
        data: { content, aiDraft },
      });
      if (updated.count !== 1)
        throw new HttpError(
          409,
          "A plan section changed while the goal was being removed. Nothing was changed; try again.",
        );
      await tx.planSectionRevision.create({
        data: {
          orgId: ctx.orgId,
          sectionId: s.id,
          kind: "goal_renumbered",
          content,
          diff: lineDiff(s.content, content),
          userId: ctx.userId,
        },
      });
    }
    // The goal's domain and category only: no goal text.
    await audit(tx, {
      action: "goal:remove",
      entityType: "Goal",
      entityId: goalId,
      meta: {
        clientId,
        domain: goal.domain,
        category: goal.category,
        ordinal: removed,
        renumbered: later.length,
        sectionsToRedraft: toRedraft.length,
        sectionsRenumbered: toRenumber.length,
      },
    });
  });
}

export const DISCONTINUE_REASON_MAX = 500;

function isRealDay(s: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

/** Discontinue a goal with history: its data and graph stay, reported as discontinued with the date and reason. */
export async function discontinueGoal(
  ctx: OrgCtx,
  goalId: string,
  input: { reason: string; date: Day },
  asOf: Day,
) {
  requirePermission(ctx.role, "goal:write");
  const reason = input.reason.trim();
  if (!reason) throw new HttpError(422, "Say why the goal is being discontinued");
  if (reason.length > DISCONTINUE_REASON_MAX)
    throw new HttpError(422, `Keep the reason to ${DISCONTINUE_REASON_MAX} characters or fewer`);
  if (/\{\{|\}\}/.test(reason))
    throw new HttpError(422, "Write the reason in your own words, without value references");
  if (!isRealDay(input.date)) throw new HttpError(422, "Use a real date (YYYY-MM-DD)");
  if (input.date > asOf) throw new HttpError(422, "The date discontinued cannot be after today");
  return withOrg(ctx, async (tx) => {
    await assertGoalClientActive(tx, goalId);
    const g = await tx.goal.findUniqueOrThrow({ where: { id: goalId } });
    if (g.progressStatus === "discontinued") throw new HttpError(409, "This goal is already discontinued");
    if (g.introducedAt && input.date < toDay(g.introducedAt))
      throw new HttpError(422, "The date discontinued cannot be before the date introduced");
    const saved = await tx.goal.update({
      where: { id: goalId },
      data: {
        progressStatus: "discontinued",
        discontinuedOn: new Date(`${input.date}T00:00:00Z`),
        discontinuedReason: reason,
      },
    });
    await audit(tx, {
      action: "goal:discontinue",
      entityType: "Goal",
      entityId: goalId,
      // The date is a plain value; the reason is free text, so only its hash is kept.
      meta: { from: g.progressStatus, discontinuedOn: input.date, reasonHash: sha256(reason) },
    });
    return { updatedAt: saved.updatedAt.toISOString() };
  });
}

/** Put a discontinued goal back in progress; the date and reason are cleared (the audit log keeps the history). */
export async function resumeGoal(ctx: OrgCtx, goalId: string) {
  requirePermission(ctx.role, "goal:write");
  return withOrg(ctx, async (tx) => {
    await assertGoalClientActive(tx, goalId);
    const g = await tx.goal.findUniqueOrThrow({ where: { id: goalId } });
    const r = await tx.goal.updateMany({
      where: { id: goalId, progressStatus: "discontinued" },
      data: { progressStatus: "in_progress", discontinuedOn: null, discontinuedReason: null },
    });
    if (r.count === 0) throw new HttpError(409, "This goal is not discontinued");
    // What was cleared, so the history can be reconstructed (the reason as a hash only).
    await audit(tx, {
      action: "goal:resume",
      entityType: "Goal",
      entityId: goalId,
      meta: {
        discontinuedOn: g.discontinuedOn ? toDay(g.discontinuedOn) : null,
        reasonHash: g.discontinuedReason ? sha256(g.discontinuedReason) : null,
      },
    });
    const saved = await tx.goal.findUniqueOrThrow({ where: { id: goalId }, select: { updatedAt: true } });
    return { updatedAt: saved.updatedAt.toISOString() };
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
