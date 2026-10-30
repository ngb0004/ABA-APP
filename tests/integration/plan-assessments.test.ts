import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { MockProvider, setLlmProvider } from "@/lib/ai";
import { withOrg } from "@/lib/db";
import { ForbiddenError, HttpError } from "@/lib/log";
import { buildSourcedContext, loadPlanBundle } from "@/lib/plan/context";
import { confirmAssessment, createAssessment, deleteAssessment } from "@/lib/services/assessments";
import { evaluateClientRules } from "@/lib/services/payors";
import { approveSection, createPlan, draftSection, planView, setPlanAssessments } from "@/lib/services/plans";
import { sid } from "../../seed/synthetic/dataset";
import { AS_OF } from "../helpers/synthetic-eval";
import { clientId, ctxAs } from "../helpers/ctx";

const bcba = ctxAs("BCBA");
const rbt = ctxAs("RBT");
const charlie = clientId("client3");
const vinelandOld = sid("c3:as:vineland:1");
const vinelandNew = sid("c3:as:vineland:2");
const srs = sid("c3:as:srs2");
const pddbi = sid("c3:as:pddbi");
const psi = sid("c3:as:psi4");
let planId: string;
const created: string[] = [];

beforeAll(async () => {
  planId = (await createPlan(bcba, charlie, "reauth")).id;
});
afterEach(() => setLlmProvider(null));
// Other files expect Charlie's seeded assessments: remove the ones made here.
afterAll(async () => {
  await withOrg(bcba, async (tx) => {
    const plans = await tx.plan.findMany({ where: { clientId: charlie } });
    for (const p of plans)
      await tx.plan.update({
        where: { id: p.id },
        data: { assessmentIds: p.assessmentIds.filter((x) => !created.includes(x)) },
      });
    await tx.assessmentScore.deleteMany({ where: { assessmentId: { in: created } } });
    await tx.assessment.deleteMany({ where: { id: { in: created } } });
  });
});

const sectionOf = (key: string) =>
  withOrg(bcba, (tx) => tx.planSection.findUniqueOrThrow({ where: { planId_key: { planId, key } } }));
const selectionOf = async () =>
  (await withOrg(bcba, (tx) => tx.plan.findUniqueOrThrow({ where: { id: planId } }))).assessmentIds;

describe("assessments used in a plan", () => {
  it("defaults to the confirmed assessments from the last twelve months", async () => {
    const ids = await selectionOf();
    for (const id of [vinelandNew, srs, pddbi, psi]) expect(ids).toContain(id);
    expect(ids).not.toContain(vinelandOld);
    const v = await planView(bcba, planId, AS_OF);
    const vb = v.assessmentOptions.filter((o) => o.vbmapp);
    expect(vb.length).toBeGreaterThan(0);
    expect(vb.every((o) => o.selected)).toBe(true);
    expect(v.assessmentOptions.find((o) => o.id === vinelandOld)!.selected).toBe(false);
    // Sourced values for the selected ones; VB-MAPP keys are unchanged.
    const keys = v.sourced.map((s) => s.key);
    expect(keys).toContain("assessment.vineland_3.2.abc");
    expect(keys).toContain("assessment.pddbi_parent.1.autism_composite");
    expect(keys.some((k) => k.startsWith("assessment.vineland_3.1."))).toBe(false);
    expect(keys.some((k) => k.startsWith("score.total.admin"))).toBe(true);
  });

  it("drafts the assessment section from the selected assessments, names and tokens only", async () => {
    const mock = new MockProvider();
    setLlmProvider(mock);
    const r = await draftSection(bcba, planId, "assessment_results", AS_OF);
    expect(r.text).toMatch(/\{\{assessment\.[a-z0-9_]+\.\d+\.name\}\}/);
    const call = mock.calls.at(-1)!;
    const payload = JSON.parse(call.user) as {
      assessments: { name: string; scores: { scale: string; token: string }[] }[];
      availableValues: { key: string }[];
    };
    expect(payload.assessments.map((a) => a.name)).toContain("{{assessment.vineland_3.2.name}}");
    expect(payload.availableValues.some((v) => v.key === "assessment.srs_2.1.total_t")).toBe(true);
    for (const banned of ["Charlie", "Testchild", "SYN-TRI-000303", '"value"', "Vineland-3"])
      expect(call.user).not.toContain(banned);
    // Other sections never see assessment scores.
    await draftSection(bcba, planId, "crisis_plan", AS_OF);
    expect(mock.calls.at(-1)!.user).not.toContain("assessment.");
  });

  it("changing the selection flags the section for a redraft, reopening it if approved", async () => {
    await withOrg(bcba, (tx) =>
      tx.planSection.update({
        where: { planId_key: { planId, key: "assessment_results" } },
        data: { state: "approved", approvedById: bcba.userId, approvedAt: new Date() },
      }),
    );
    const before = await selectionOf();
    const r = await setPlanAssessments(
      bcba,
      planId,
      before.filter((x) => x !== srs),
    );
    expect(r).toEqual({ changed: true, redraft: ["assessment_results"] });
    const s = await sectionOf("assessment_results");
    expect(s.state).toBe("draft");
    expect(s.approvedAt).toBeNull();
    expect(s.redraftReason).toMatch(/assessments used in this plan changed/);
    // Sections that do not use assessments are untouched.
    expect((await sectionOf("crisis_plan")).redraftReason).toBeNull();
    // Approval waits for a redraft or an edit; nothing is approved automatically.
    await expect(approveSection(bcba, planId, "assessment_results", AS_OF)).rejects.toThrow(
      /Redraft it with AI or edit it/,
    );
    const audit = await withOrg(bcba, (tx) =>
      tx.auditEvent.findMany({ where: { action: "plan:assessments", entityId: planId } }),
    );
    expect(audit).toHaveLength(1);
    expect(audit[0]!.meta).toMatchObject({ added: 0, removed: 1, redraft: ["assessment_results"] });
    // The deselected assessment's tokens are gone; the draft's own tokens no longer all resolve.
    const keys = (await planView(bcba, planId, AS_OF)).sourced.map((v) => v.key);
    expect(keys.some((k) => k.startsWith("assessment.srs_2."))).toBe(false);

    setLlmProvider(new MockProvider());
    await draftSection(bcba, planId, "assessment_results", AS_OF);
    expect((await sectionOf("assessment_results")).redraftReason).toBeNull();
  });

  it("an unchanged selection changes nothing", async () => {
    expect(await setPlanAssessments(bcba, planId, await selectionOf())).toEqual({
      changed: false,
      redraft: [],
    });
    expect((await sectionOf("assessment_results")).redraftReason).toBeNull();
  });

  it("refuses another client's assessments, finalized plans, and roles that cannot edit", async () => {
    await expect(setPlanAssessments(bcba, planId, [sid("c1:as:ablls")])).rejects.toThrow(HttpError);
    await expect(setPlanAssessments(rbt, planId, [])).rejects.toThrow(ForbiddenError);
    const other = (await createPlan(bcba, charlie, "reauth")).id;
    await withOrg(bcba, (tx) => tx.plan.update({ where: { id: other }, data: { status: "finalized" } }));
    await expect(setPlanAssessments(bcba, other, [])).rejects.toThrow(/finalized/);
  });

  it("a selected draft gives no scores until confirmed; confirming it flags the section", async () => {
    const d = await createAssessment(
      bcba,
      charlie,
      {
        typeKey: "srs_2",
        form: "school_age",
        respondent: "teacher",
        administeredOn: "2026-10-15",
        administeredBy: "BCBA-Q",
        scores: [{ scaleKey: "total_t", value: 68 }],
      },
      AS_OF,
    );
    created.push(d.id);
    await setPlanAssessments(bcba, planId, [...(await selectionOf()), d.id]);
    setLlmProvider(new MockProvider());
    await draftSection(bcba, planId, "assessment_results", AS_OF);
    const audit = async () =>
      withOrg(bcba, async (tx) => {
        const b = await loadPlanBundle(tx, planId);
        const { results } = await evaluateClientRules(tx, b.client.id, AS_OF, planId);
        const sourced = buildSourcedContext(b, AS_OF);
        return { sourced, results, b };
      });
    const before = await audit();
    expect(before.sourced.keys().some((k) => k.startsWith("assessment.srs_2.2."))).toBe(false);
    const checks = (await planView(bcba, planId, AS_OF)).checks;
    expect(checks.find((c) => c.id === "assessments.drafts")).toMatchObject({ status: "warn" });

    await confirmAssessment(bcba, charlie, d.id);
    expect((await sectionOf("assessment_results")).redraftReason).not.toBeNull();
    const after = await audit();
    expect(after.sourced.has("assessment.srs_2.2.total_t")).toBe(true);
  });

  it("selecting or deselecting a draft reopens nothing: drafts give no values", async () => {
    const d = await createAssessment(
      bcba,
      charlie,
      {
        typeKey: "srs_2",
        administeredOn: "2026-10-18",
        administeredBy: "BCBA-Q",
        scores: [{ scaleKey: "total_t", value: 66 }],
      },
      AS_OF,
    );
    created.push(d.id);
    const approve = () =>
      withOrg(bcba, (tx) =>
        tx.planSection.update({
          where: { planId_key: { planId, key: "assessment_results" } },
          data: { state: "approved", approvedById: bcba.userId, approvedAt: new Date(), redraftReason: null },
        }),
      );
    await approve();
    const base = (await selectionOf()).filter((x) => x !== d.id);
    expect(await setPlanAssessments(bcba, planId, [...base, d.id])).toEqual({ changed: true, redraft: [] });
    expect(await sectionOf("assessment_results")).toMatchObject({ state: "approved", redraftReason: null });
    expect(await setPlanAssessments(bcba, planId, base)).toEqual({ changed: true, redraft: [] });
    expect(await sectionOf("assessment_results")).toMatchObject({ state: "approved", redraftReason: null });
  });

  it("a back-dated administration confirmed later never renumbers tokens, in open or finalized plans", async () => {
    const two = (await createPlan(bcba, charlie, "reauth")).id;
    await setPlanAssessments(bcba, two, [vinelandOld, vinelandNew]);
    // A BCBA may cite an assessment token in any section; this one is approved and finalized.
    await withOrg(bcba, async (tx) => {
      await tx.planSection.update({
        where: { planId_key: { planId: two, key: "medical_necessity" } },
        data: {
          content: "ABC {{assessment.vineland_3.2.abc}}.",
          state: "approved",
          approvedById: bcba.userId,
          approvedAt: new Date(),
        },
      });
      await tx.plan.update({ where: { id: two }, data: { status: "finalized" } });
    });
    const values = async (id: string) =>
      Object.fromEntries(
        (await planView(bcba, id, AS_OF)).sourced
          .filter((v) => v.key.startsWith("assessment.vineland_3."))
          .map((v) => [v.key, v.value]),
      );
    const before = await values(two);
    expect(before["assessment.vineland_3.2.abc"]).toBeDefined();

    const older = await createAssessment(
      bcba,
      charlie,
      {
        typeKey: "vineland_3",
        administeredOn: "2024-01-10",
        administeredBy: "BCBA-Q",
        scores: [{ scaleKey: "abc", value: 58 }],
      },
      AS_OF,
    );
    created.push(older.id);
    await confirmAssessment(bcba, charlie, older.id);
    const stored = await withOrg(bcba, (tx) =>
      tx.assessment.findMany({
        where: { id: { in: [vinelandOld, vinelandNew, older.id] } },
        select: { id: true, seriesKey: true, seriesNumber: true },
      }),
    );
    const n = (id: string) => stored.find((x) => x.id === id)!.seriesNumber;
    expect([n(vinelandOld), n(vinelandNew), n(older.id)]).toEqual([1, 2, 3]);
    // The finalized plan reads exactly as before, and its approved section was not reopened.
    expect(await values(two)).toEqual(before);
    const mn = await withOrg(bcba, (tx) =>
      tx.planSection.findUniqueOrThrow({ where: { planId_key: { planId: two, key: "medical_necessity" } } }),
    );
    expect(mn).toMatchObject({ state: "approved", redraftReason: null });
    // Selecting it in an open plan gives it the next number.
    await setPlanAssessments(bcba, planId, [...(await selectionOf()), older.id]);
    const keys = (await planView(bcba, planId, AS_OF)).sourced.map((v) => v.key);
    expect(keys).toContain("assessment.vineland_3.3.abc");
    expect(keys).toContain("assessment.vineland_3.2.abc");
  });

  it("deleting a selected draft drops it from the selection", async () => {
    const d = await createAssessment(
      bcba,
      charlie,
      {
        typeKey: "psi_4",
        form: "short_form",
        respondent: "parent_caregiver",
        administeredOn: "2026-10-16",
        administeredBy: "BCBA-Q",
        scores: [{ scaleKey: "total_stress_pct", value: 80 }],
      },
      AS_OF,
    );
    await setPlanAssessments(bcba, planId, [...(await selectionOf()), d.id]);
    expect(await selectionOf()).toContain(d.id);
    await deleteAssessment(bcba, charlie, d.id);
    expect(await selectionOf()).not.toContain(d.id);
  });
});

describe("payor outcome measures from confirmed assessments", () => {
  it("Charlie's TRICARE schedule shows when the Vineland-3 was last given and when it is due", async () => {
    const { results } = await withOrg(bcba, (tx) => evaluateClientRules(tx, charlie, AS_OF, planId));
    const om = results.filter((r) => r.rule.type === "outcome_measure_schedule" && r.schedule);
    expect(om.length).toBeGreaterThan(0);
    const lines = om.flatMap((r) => r.schedule ?? []);
    expect(
      lines.some((l) => /^Vineland-3 last given \d{4}-\d{2}-\d{2}: due by \d{4}-\d{2}-\d{2}$/.test(l)),
    ).toBe(true);
    // Unverified rules only warn.
    expect(om.every((r) => r.rule.verified || r.status !== "fail")).toBe(true);
  });
});
