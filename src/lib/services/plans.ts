/**
 * Treatment plan builder. Section workflow: draft → edited → approved, one
 * section at a time, BCBA only. There is intentionally no "approve all".
 */
import type { Prisma } from "@prisma/client";
import { draftWithFirewall } from "../ai";
import { audit, sha256 } from "../audit";
import { withOrg, type OrgCtx, type Tx } from "../db";
import { toDay, type Day } from "../dates";
import { renderTokens, validateBcbaText } from "../firewall";
import { unresolvedPlaceholders } from "../goals/checks";
import { goalTokenOrdinals, renumberGoalTokens } from "../goals/renumber";
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
    await audit(tx, { action: "plan:create", entityType: "Plan", entityId: plan.id, meta: { type } });
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
      needsRedraft: !!((s.items ?? {}) as Record<string, ItemState>)[NEEDS_REDRAFT_ITEM],
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
    return {
      bundle: b,
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
        items: withoutRedraftFlag(current.items),
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

/**
 * Where a section is marked for redraft after a goal it covered was removed. Drafting it again
 * or editing it clears the mark; it cannot be approved while marked.
 */
export const NEEDS_REDRAFT_ITEM = "_needs_redraft";
export const NEEDS_REDRAFT_NOTE =
  "A goal was removed after this section was written. Draft it again or edit it before approving.";

function withoutRedraftFlag(items: unknown): Prisma.InputJsonValue {
  const out = { ...((items ?? {}) as Record<string, ItemState>) };
  delete out[NEEDS_REDRAFT_ITEM];
  return out as Prisma.InputJsonValue;
}

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
      data: { content: v.normalized, state: "edited", items: withoutRedraftFlag(section.items) },
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
    if (!section.content.trim()) problems.push("Section has no content");
    if (((section.items ?? {}) as Record<string, ItemState>)[NEEDS_REDRAFT_ITEM])
      problems.push(NEEDS_REDRAFT_NOTE.replace(/\.$/, ""));
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
  if (data.progressStatus === "discontinued")
    throw new HttpError(422, "Use Discontinue in the goal's menu: it records the date and your reason.");
  return withOrg(ctx, async (tx) => {
    if (data.progressStatus !== undefined) {
      const cur = await tx.goal.findUniqueOrThrow({ where: { id: goalId } });
      if (cur.progressStatus === "discontinued")
        throw new HttpError(422, "This goal is discontinued. Use Resume in the goal's menu first.");
    }
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
  const since = goal.createdAt;
  for (const p of rc.plans) {
    if (p.status === "finalized" && (!p.finalizedAt || p.finalizedAt >= since))
      return `This goal is in a finalized plan, so it can't be removed. ${DISCONTINUE_INSTEAD}`;
    const pk = p.packet;
    if (
      pk &&
      (pk.status === "submitted" ||
        (pk.exportedAt && pk.exportedAt >= since) ||
        (pk.submittedAt && pk.submittedAt >= since))
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
  // Removing renumbers later goals; approved text that refers to them by number must not change.
  for (const p of rc.plans)
    for (const s of p.sections)
      if (
        (s.state === "approved" || p.status === "finalized") &&
        goalTokenOrdinals(s.content).some((k) => k > goal.ordinal)
      )
        return `A later goal is referred to in an approved plan section, and removing this one would renumber it. Reopen that section first, or discontinue this goal instead.`;
  return null;
}

/** Remove a goal added by mistake. Later goals move down one; drafted sections that covered it are marked for redraft. */
export async function removeGoal(ctx: OrgCtx, goalId: string) {
  requirePermission(ctx.role, "goal:approve");
  return withOrg(ctx, async (tx) => {
    const { clientId } = await tx.goal.findUniqueOrThrow({
      where: { id: goalId },
      select: { clientId: true },
    });
    const rc = await loadGoalRemovalContext(tx, clientId);
    const goal = rc.goals.find((g) => g.id === goalId)!;
    const blocker = goalRemovalBlocker(goal, rc);
    if (blocker) throw new HttpError(409, blocker);
    const removed = goal.ordinal;

    // Open sections written while the goal existed, or that refer to it or a later goal by number.
    const toRedraft = rc.plans
      .filter((p) => p.status !== "finalized")
      .flatMap((p) => p.sections)
      .filter((s) => (s.state === "draft" || s.state === "edited") && (s.content.trim() || s.aiDraft))
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
    for (const g of later)
      await tx.goal.update({
        where: { id: g.id },
        data: {
          ordinal: g.ordinal - 1,
          objective: re(g.objective),
          rationale: re(g.rationale),
          sd: re(g.sd),
          targetBehavior: re(g.targetBehavior),
          generalization: re(g.generalization),
          barriers: re(g.barriers),
          flatExplanation: g.flatExplanation === null ? null : re(g.flatExplanation),
        },
      });

    for (const s of toRedraft) {
      const content = re(s.content);
      const aiDraft = s.aiDraft === null ? null : re(s.aiDraft);
      await tx.planSection.update({
        where: { id: s.id },
        data: {
          content,
          aiDraft,
          items: {
            ...((s.items ?? {}) as Record<string, ItemState>),
            [NEEDS_REDRAFT_ITEM]: { status: "none", note: NEEDS_REDRAFT_NOTE },
          } as Prisma.InputJsonValue,
        },
      });
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
    const g = await tx.goal.findUniqueOrThrow({ where: { id: goalId } });
    if (g.progressStatus === "discontinued") throw new HttpError(409, "This goal is already discontinued");
    if (g.introducedAt && input.date < toDay(g.introducedAt))
      throw new HttpError(422, "The date discontinued cannot be before the date introduced");
    await tx.goal.update({
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
      meta: { from: g.progressStatus, reasonHash: sha256(reason) },
    });
  });
}

/** Put a discontinued goal back in progress; the date and reason are cleared (the audit log keeps the history). */
export async function resumeGoal(ctx: OrgCtx, goalId: string) {
  requirePermission(ctx.role, "goal:write");
  return withOrg(ctx, async (tx) => {
    const r = await tx.goal.updateMany({
      where: { id: goalId, progressStatus: "discontinued" },
      data: { progressStatus: "in_progress", discontinuedOn: null, discontinuedReason: null },
    });
    if (r.count === 0) {
      await tx.goal.findUniqueOrThrow({ where: { id: goalId } });
      throw new HttpError(409, "This goal is not discontinued");
    }
    await audit(tx, { action: "goal:resume", entityType: "Goal", entityId: goalId });
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
