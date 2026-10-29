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
import { intakeForAi, pseudonymNames, safetyFlags } from "../intake/derive";
import { INTAKE_FIELDS, isNa, type IntakeAnswers } from "../intake/schema";
import { HttpError } from "../log";
import { requirePermission } from "../permissions";
import { buildSourcedContext, loadPlanBundle, type GoalStatus, type PlanBundle } from "../plan/context";
import { baseline, BASELINE_POINTS } from "../plan/progress";
import { lineDiff } from "../plan/diff";
import { goalGraphSvg } from "../plan/graphs";
import { exportBlockers, runPresubmissionAudit } from "../plan/presubmission";
import {
  intakeKeysFor,
  SECTIONS,
  SECTION_BY_KEY,
  sectionDone,
  sectionsForTopic,
  type SectionDef,
} from "../plan/sections";
import type { RuleResult } from "../payors/types";
import { renderMilestonesGridSvg } from "../vbmapp/grid-svg";
import { evaluateClientRules, loadRules } from "./payors";

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
  const intakeKeys = intakeKeysFor(def);
  const items: RequiredItem[] = [];
  for (const i of def.items.filter((x) => !x.reauthOnly || planType === "reauth"))
    items.push({
      key: i.key,
      label: i.label,
      status: stored[i.key]?.status ?? null,
      auto: false,
      note: stored[i.key]?.note,
    });
  for (const f of INTAKE_FIELDS.filter(
    (x) => x.feeds_sections.some((k) => intakeKeys.includes(k)) && x.sensitivity !== "restricted",
  )) {
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
  return p ? loadRules(tx, p.payorId) : [];
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
    const rules = primary ? await loadRules(tx, primary.payorId) : [];
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
    const { results } = await evaluateClientRules(tx, b.client.id, asOf, planId);
    const checks = runPresubmissionAudit(b, sourced, results, asOf);
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

const SYSTEM_PROMPT = `You draft one section of an ABA treatment plan. A Board Certified Behavior Analyst reviews, edits, and approves every section; your draft is a starting point.
Write two or three short paragraphs of plain clinical prose. No headings, lists, or markdown. Be specific to the information provided and do not invent facts, assessments, or history.`;

export async function draftSection(ctx: OrgCtx, planId: string, key: string, asOf: Day) {
  requirePermission(ctx.role, "section:draft");
  const def = SECTION_BY_KEY.get(key);
  if (!def) throw new HttpError(404, "Unknown section");
  if (def.bcbaOnly) throw new HttpError(400, "This section is written by the BCBA");
  return withOrg(ctx, async (tx) => {
    const b = await loadPlanBundle(tx, planId);
    const section = b.plan.sections.find((s) => s.key === key)!;
    if (!section) throw new HttpError(404, "Unknown section");
    assertOpen(section.state, "drafting again");
    const sourced = buildSourcedContext(b, asOf);
    const names = pseudonymNames(b.client);
    const answers = (b.intake?.answers ?? {}) as IntakeAnswers;
    const intakeKeys = intakeKeysFor(def);
    const sectionAnswers = Object.fromEntries(
      Object.entries(answers).filter(([id]) =>
        INTAKE_FIELDS.find((f) => f.id === id)?.feeds_sections.some((k) => intakeKeys.includes(k)),
      ),
    );
    const payload: Record<string, unknown> = {
      task: "draft_section",
      sectionKey: def.key,
      sectionTitle: def.title,
      planType: b.plan.type,
      guidance: def.guidance,
      availableValues: sourced.forModel(["client.name", "caregiver.primary", ...def.valuePrefixes]),
      intake: intakeForAi(sectionAnswers as IntakeAnswers, names),
    };
    const goalsFor = def.context?.goals;
    if (goalsFor)
      payload.goals = b.goals
        .filter((g) => goalsFor === true || goalsFor.includes(g.category))
        .map((g) => ({
          goalNumber: `goal.${g.ordinal}`,
          domain: g.domain,
          category: g.category,
          measure: g.measure,
          objective: g.objective,
          status: g.progressStatus,
          trend:
            sourced.get(`goal.${g.ordinal}.current_${g.measure === "percent" ? "pct" : "rate"}`)?.facts ?? [],
        }));
    if (def.context?.safetyFlags) payload.staffSafetyFlags = safetyFlags(answers).map((f) => f.label);
    if (def.context?.isolatedScores) {
      const flags = b.administrations.flatMap((a) =>
        (a.flags as { code: string; level?: number; domain?: string }[])
          .filter((f) => f.code === "isolated_score")
          .map((f) => `Level ${f.level} ${f.domain}`),
      );
      payload.isolatedScoreFlags = [...new Set(flags)];
    }
    const result = await draftWithFirewall(tx, {
      system: SYSTEM_PROMPT,
      payload,
      sourced,
      identifiers: {
        names: [...names.client, ...names.others],
        dob: toDay(b.client.dob),
        memberIds: b.client.payors.map((p) => p.memberId),
      },
      audit: { entityType: "PlanSection", entityId: section.id, section: def.key, task: "draft_section" },
    });
    await tx.planSection.update({
      where: { id: section.id },
      data: {
        aiDraft: result.text,
        content: result.text,
        state: "draft",
        approvedAt: null,
        approvedById: null,
      },
    });
    await tx.planSectionRevision.create({
      data: {
        orgId: ctx.orgId,
        sectionId: section.id,
        kind: "ai_draft",
        content: result.text,
        userId: ctx.userId,
      },
    });
    return { text: result.text, attempts: result.attempts };
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
      data: { content: v.normalized, state: "edited" },
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
        state: section.content.trim() ? "edited" : "draft",
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
    await tx.goal.update({
      where: { id: goalId },
      data: {
        baselineValue: value,
        baselineDate: new Date(`${date}T00:00:00Z`),
        baselineLockedAt: new Date(),
        baselineLockedById: ctx.userId,
      },
    });
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
  const { results } = await evaluateClientRules(tx, b.client.id, asOf, planId);
  const blockers = exportBlockers(runPresubmissionAudit(b, sourced, results, asOf));
  const unapproved = b.plan.sections.filter((s) => !sectionDone(s.state));
  if (unapproved.length || blockers.length)
    throw new HttpError(
      409,
      `Export blocked: ${unapproved.length} section(s) not approved; ${blockers.length} audit check(s) failing`,
    );
  return { bundle: b, results };
}
