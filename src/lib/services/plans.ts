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
import { buildSourcedContext, loadPlanBundle, type PlanBundle } from "../plan/context";
import { lineDiff } from "../plan/diff";
import { goalGraphSvg } from "../plan/graphs";
import { exportBlockers, runPresubmissionAudit } from "../plan/presubmission";
import { SECTIONS, SECTION_BY_KEY } from "../plan/sections";
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

const PAYOR_TOPIC_SECTION: Record<string, string> = {
  background: "background",
  goals: "skill_goals",
  coordination_of_care: "coordination",
  care_coordination: "coordination",
  transition_plan: "transition",
  transition_fade_plan_tied_to_goals: "transition",
  discharge_criteria: "transition",
  discharge_plan: "transition",
  crisis_plan: "crisis",
  generalization_to_caregivers: "caregiver",
  evaluation_date: "assessment",
};

export function requiredItemsFor(
  sectionKey: string,
  planType: string,
  answers: IntakeAnswers,
  rules: { type: string; params: Record<string, unknown>; source: { name: string | null } }[],
  stored: Record<string, ItemState>,
): RequiredItem[] {
  const def = SECTION_BY_KEY.get(sectionKey as never)!;
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
    (x) => x.feeds_sections.includes(def.key) && x.sensitivity !== "restricted",
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
      if (PAYOR_TOPIC_SECTION[topic] !== def.key) continue;
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
      ),
      bcbaOnly: SECTION_BY_KEY.get(s.key as never)?.bcbaOnly ?? false,
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
  const def = SECTION_BY_KEY.get(key as never);
  if (!def) throw new HttpError(404, "Unknown section");
  if (def.bcbaOnly) throw new HttpError(400, "This section is written by the BCBA");
  return withOrg(ctx, async (tx) => {
    const b = await loadPlanBundle(tx, planId);
    const section = b.plan.sections.find((s) => s.key === key)!;
    if (section.state === "approved")
      throw new HttpError(409, "Section is approved. Reopen it before drafting again.");
    const sourced = buildSourcedContext(b, asOf);
    const names = pseudonymNames(b.client);
    const answers = (b.intake?.answers ?? {}) as IntakeAnswers;
    const sectionAnswers = Object.fromEntries(
      Object.entries(answers).filter(([id]) =>
        INTAKE_FIELDS.find((f) => f.id === id)?.feeds_sections.includes(def.key),
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
    if (
      ["skill_goals", "behavior_goals", "caregiver", "transition", "behavior", "services"].includes(def.key)
    )
      payload.goals = b.goals.map((g) => ({
        goalNumber: `goal.${g.ordinal}`,
        domain: g.domain,
        category: g.category,
        measure: g.measure,
        objective: g.objective,
        trend:
          sourced.get(`goal.${g.ordinal}.current_${g.measure === "percent" ? "pct" : "rate"}`)?.facts ?? [],
      }));
    if (def.key === "crisis" || def.key === "behavior")
      payload.staffSafetyFlags = safetyFlags(answers).map((f) => f.label);
    if (def.key === "assessment") {
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

export async function editSection(ctx: OrgCtx, planId: string, key: string, content: string, asOf: Day) {
  requirePermission(ctx.role, "section:edit");
  return withOrg(ctx, async (tx) => {
    const b = await loadPlanBundle(tx, planId);
    const section = b.plan.sections.find((s) => s.key === key);
    if (!section) throw new HttpError(404, "Unknown section");
    if (section.state === "approved")
      throw new HttpError(409, "Section is approved. Reopen it before editing.");
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
    if (section.state === "approved")
      throw new HttpError(409, "Section is approved. Reopen it before changing items.");
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

export async function reopenSection(ctx: OrgCtx, planId: string, key: string) {
  requirePermission(ctx.role, "section:approve");
  return withOrg(ctx, async (tx) => {
    const section = await tx.planSection.findUniqueOrThrow({ where: { planId_key: { planId, key } } });
    await tx.planSection.update({
      where: { id: section.id },
      data: { state: "edited", approvedAt: null, approvedById: null },
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
  },
) {
  requirePermission(ctx.role, "goal:write");
  return withOrg(ctx, async (tx) => {
    // Changing what the goal says sends it back for approval; a flat-progress explanation does not.
    const changesContent = [
      "objective",
      "rationale",
      "masteryAccuracyPct",
      "masteryConsecutiveSessions",
      "masteryInstructors",
    ].some((k) => k in data);
    await tx.goal.update({
      where: { id: goalId },
      data: { ...data, ...(changesContent ? { status: "draft", approvedAt: null, approvedById: null } : {}) },
    });
    await audit(tx, {
      action: "goal:update",
      entityType: "Goal",
      entityId: goalId,
      meta: { fields: Object.keys(data) },
    });
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
  const unapproved = b.plan.sections.filter((s) => s.state !== "approved");
  if (unapproved.length || blockers.length)
    throw new HttpError(
      409,
      `Export blocked: ${unapproved.length} section(s) not approved; ${blockers.length} audit check(s) failing`,
    );
  return { bundle: b, results };
}
