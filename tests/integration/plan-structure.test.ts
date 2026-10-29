import { describe, expect, it } from "vitest";
import { MockProvider, setLlmProvider } from "@/lib/ai";
import { withOrg } from "@/lib/db";
import { buildSourcedContext, loadPlanBundle } from "@/lib/plan/context";
import { runPresubmissionAudit } from "@/lib/plan/presubmission";
import { LEGACY_SECTIONS } from "@/lib/plan/sections";
import { evaluateClientRules } from "@/lib/services/payors";
import {
  approveSection,
  createPlan,
  draftSection,
  editSection,
  lockGoalBaseline,
  markSectionNotApplicable,
  planView,
  reopenSection,
  setSectionItem,
  updateGoal,
} from "@/lib/services/plans";
import { AS_OF } from "../helpers/synthetic-eval";
import { clientId, ctxAs } from "../helpers/ctx";

const bcba = ctxAs("BCBA");

async function auditFor(pid: string) {
  return withOrg(bcba, async (tx) => {
    const b = await loadPlanBundle(tx, pid);
    const { results } = await evaluateClientRules(tx, b.client.id, AS_OF, pid);
    return runPresubmissionAudit(b, buildSourcedContext(b, AS_OF), results, AS_OF);
  });
}

describe("conditional sections", () => {
  it("only group, school, and telehealth sections can be marked not applicable, with a reason", async () => {
    const plan = await createPlan(bcba, clientId("client1"), "initial");
    await expect(markSectionNotApplicable(bcba, plan.id, "crisis_plan", "Not needed")).rejects.toMatchObject({
      status: 422,
    });
    await expect(markSectionNotApplicable(bcba, plan.id, "school_plan", "  ")).rejects.toMatchObject({
      status: 422,
    });
    await expect(
      markSectionNotApplicable(ctxAs("RBT"), plan.id, "school_plan", "Home services only"),
    ).rejects.toMatchObject({ status: 403 });
    await markSectionNotApplicable(bcba, plan.id, "school_plan", "Home services only");
    const v = await planView(bcba, plan.id, AS_OF);
    const s = v.sections.find((x) => x.key === "school_plan")!;
    expect(s).toMatchObject({ state: "not_applicable", notApplicableReason: "Home services only" });
    expect(v.checks.find((c) => c.id === "sections.approved")!.details).not.toContain(s.title);
    await expect(editSection(bcba, plan.id, "school_plan", "text", AS_OF)).rejects.toMatchObject({
      status: 409,
    });
    await reopenSection(bcba, plan.id, "school_plan");
    const again = (await planView(bcba, plan.id, AS_OF)).sections.find((x) => x.key === "school_plan")!;
    expect(again).toMatchObject({ state: "draft", notApplicableReason: null });
    const audit = await withOrg(bcba, (tx) =>
      tx.auditEvent.count({ where: { action: "section:not_applicable", entityId: s.id } }),
    );
    expect(audit).toBe(1);
  });

  it("blocks export when group codes are authorized but the group section is marked not applicable", async () => {
    const plan = await createPlan(bcba, clientId("client1"), "initial");
    await markSectionNotApplicable(bcba, plan.id, "group_goals", "No group sessions");
    expect((await auditFor(plan.id)).find((c) => c.id === "sections.condition.group_goals")).toBeUndefined();
    const authId = (await withOrg(bcba, (tx) => tx.plan.findUniqueOrThrow({ where: { id: plan.id } })))
      .authorizationId!;
    const unit = await withOrg(bcba, (tx) =>
      tx.authorizationUnit.create({
        data: {
          orgId: bcba.orgId,
          authorizationId: authId,
          cptCode: "97154",
          approvedUnits: 8,
          unitBasis: "week",
        },
      }),
    );
    try {
      const check = (await auditFor(plan.id)).find((c) => c.id === "sections.condition.group_goals");
      expect(check).toMatchObject({ status: "fail" });
    } finally {
      await withOrg(bcba, (tx) => tx.authorizationUnit.delete({ where: { id: unit.id } }));
    }
  });
});

describe("not-applicable sections keep their text out of the way", () => {
  it("their text is not checked, and reopening untouched AI text returns it to draft", async () => {
    setLlmProvider(new MockProvider());
    try {
      const plan = await createPlan(bcba, clientId("client1"), "initial");
      await draftSection(bcba, plan.id, "group_goals", AS_OF);
      await markSectionNotApplicable(bcba, plan.id, "group_goals", "No group sessions");
      await reopenSection(bcba, plan.id, "group_goals");
      const s = (await planView(bcba, plan.id, AS_OF)).sections.find((x) => x.key === "group_goals")!;
      expect(s.state).toBe("draft");
      // Text with a placeholder in a section marked not applicable does not block export.
      await editSection(bcba, plan.id, "school_plan", "Targets for [X] at school.", AS_OF);
      await markSectionNotApplicable(bcba, plan.id, "school_plan", "Home services only");
      expect((await auditFor(plan.id)).some((c) => c.id === "sections.placeholder.school_plan")).toBe(false);
    } finally {
      setLlmProvider(null);
    }
  });
});

describe("progress summaries", () => {
  it("need the baseline value, not just the baseline date", async () => {
    const plan = await createPlan(bcba, clientId("client2"), "reauth");
    const v = await planView(bcba, plan.id, AS_OF);
    const kind = (m: string) => (m === "percent" ? "pct" : "rate");
    const goals = v.goals.filter((g) => g.category !== "caregiver" && g.progressStatus !== "new");
    const dated = v.sourced.some((x) => x.key === `goal.${goals[0]!.ordinal}.baseline_date`);
    expect(dated).toBe(true);
    const text = goals
      .map(
        (g) =>
          `Since {{goal.${g.ordinal}.baseline_date}}, now {{goal.${g.ordinal}.current_${kind(g.measure)}}}.`,
      )
      .join("\n");
    await editSection(bcba, plan.id, "skill_acquisition_goals", text, AS_OF);
    expect((await auditFor(plan.id)).find((c) => c.id === "progress.summary")).toMatchObject({
      status: "fail",
    });
  });
});

describe("plans created with the eleven-section structure", () => {
  it("still open, map payor topics into their own sections, and approve", async () => {
    const plan = await createPlan(bcba, clientId("client1"), "initial");
    await withOrg(bcba, async (tx) => {
      await tx.planSection.deleteMany({ where: { planId: plan.id } });
      await tx.planSection.createMany({
        data: LEGACY_SECTIONS.map((s, i) => ({
          orgId: bcba.orgId,
          planId: plan.id,
          key: s.key,
          ordinal: i + 1,
          title: s.title,
        })),
      });
    });
    const v = await planView(bcba, plan.id, AS_OF);
    expect(v.sections.map((s) => s.key)).toEqual(LEGACY_SECTIONS.map((s) => s.key));
    // Georgia's plan_content topics land in the legacy sections (client 1 is Amerigroup, inheriting GA).
    const bg = v.sections.find((s) => s.key === "background")!;
    expect(bg.items.some((i) => i.key === "payor:medications")).toBe(true);
    expect(bg.items.some((i) => i.key.startsWith("intake:"))).toBe(true);
    // Its intake items are the ones it always had.
    expect(bg.items.some((i) => i.key === "intake:other_therapies")).toBe(false);
    await editSection(bcba, plan.id, "coordination", "Coordinated with the pediatrician.", AS_OF);
    for (const i of v.sections.find((s) => s.key === "coordination")!.items.filter((x) => x.status === null))
      await setSectionItem(bcba, plan.id, "coordination", i.key, "answered");
    await expect(approveSection(bcba, plan.id, "coordination", AS_OF)).resolves.toMatchObject({
      state: "approved",
    });
  });
});

describe("goal records", () => {
  async function newGoal() {
    return withOrg(bcba, async (tx) => {
      const g = await tx.goal.create({
        data: {
          orgId: bcba.orgId,
          clientId: clientId("client1"),
          ordinal: 90,
          domain: "Test domain",
          tier: 1,
          category: "communication",
          objective: "Test objective",
        },
      });
      await tx.goalDataPoint.createMany({
        data: [
          ["2026-08-03", 10],
          ["2026-08-05", 20],
          ["2026-08-07", 30],
          ["2026-08-10", 90],
        ].map(([date, value]) => ({
          orgId: bcba.orgId,
          goalId: g.id,
          date: new Date(`${date}T00:00:00Z`),
          value: value as number,
        })),
      });
      return g;
    });
  }

  it("locks a baseline computed from the goal's first three data points, permanently", async () => {
    const g = await newGoal();
    await expect(lockGoalBaseline(ctxAs("RBT"), g.id)).rejects.toMatchObject({ status: 403 });
    expect(await lockGoalBaseline(bcba, g.id)).toEqual({ value: 20, date: "2026-08-07" });
    await expect(lockGoalBaseline(bcba, g.id)).rejects.toMatchObject({ status: 409 });
    // The database refuses any change to a locked baseline, whatever the caller.
    await expect(
      withOrg(bcba, (tx) => tx.goal.update({ where: { id: g.id }, data: { baselineValue: 55 } })),
    ).rejects.toThrow(/baseline is locked/);
    await expect(
      withOrg(bcba, (tx) =>
        tx.$executeRawUnsafe(`UPDATE goal SET "baselineDate" = NULL WHERE id = '${g.id}'`),
      ),
    ).rejects.toThrow(/baseline is locked/);
    const plan = await createPlan(bcba, clientId("client1"), "initial");
    const v = await planView(bcba, plan.id, AS_OF);
    const bl = v.sourced.find((x) => x.key === "goal.90.baseline_pct")!;
    expect(bl).toMatchObject({ value: 20, display: "20%" });
    expect(bl.source.description).toMatch(/locked 08\/07\/2026/);
    expect(v.sourced.find((x) => x.key === "goal.90.baseline_date")).toMatchObject({ value: "2026-08-07" });
    await withOrg(bcba, async (tx) => {
      await tx.goalDataPoint.deleteMany({ where: { goalId: g.id } });
      await tx.goal.delete({ where: { id: g.id } });
    });
  });

  it("records dates and status; dates return the goal to draft, status does not", async () => {
    const g = await newGoal();
    await withOrg(bcba, (tx) => tx.goal.update({ where: { id: g.id }, data: { status: "approved" } }));
    await updateGoal(bcba, g.id, { progressStatus: "on_hold", barriers: "Family travel in August" });
    let row = await withOrg(bcba, (tx) => tx.goal.findUniqueOrThrow({ where: { id: g.id } }));
    expect(row).toMatchObject({ status: "approved", progressStatus: "on_hold" });
    await expect(
      updateGoal(bcba, g.id, { introducedAt: "2026-09-01", projectedMasteryDate: "2026-08-01" }),
    ).rejects.toMatchObject({ status: 422 });
    await updateGoal(bcba, g.id, { introducedAt: "2026-08-03", projectedMasteryDate: "2027-02-01" });
    row = await withOrg(bcba, (tx) => tx.goal.findUniqueOrThrow({ where: { id: g.id } }));
    expect(row.status).toBe("draft");
    const plan = await createPlan(bcba, clientId("client1"), "initial");
    const v = await planView(bcba, plan.id, AS_OF);
    expect(v.sourced.find((x) => x.key === "goal.90.introduced")).toMatchObject({ display: "08/03/2026" });
    expect(v.sourced.find((x) => x.key === "goal.90.projected_mastery")).toMatchObject({
      value: "2027-02-01",
    });
    const onHold = v.sourced.find((x) => x.key === "goals.count.on_hold")!;
    expect(onHold.value).toBe(v.goals.filter((x) => x.progressStatus === "on_hold").length);
    expect(onHold.value).toBeGreaterThanOrEqual(1);
    expect(v.sourced.find((x) => x.key === "goals.count.total")!.value).toBe(v.goals.length);
    await withOrg(bcba, async (tx) => {
      await tx.goalDataPoint.deleteMany({ where: { goalId: g.id } });
      await tx.goal.delete({ where: { id: g.id } });
    });
  });
});
