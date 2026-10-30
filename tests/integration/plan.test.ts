import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { MockProvider, setLlmProvider, AiFirewallError } from "@/lib/ai";
import { withOrg } from "@/lib/db";
import { ForbiddenError, HttpError } from "@/lib/log";
import { buildSourcedContext, loadPlanBundle } from "@/lib/plan/context";
import { runPresubmissionAudit } from "@/lib/plan/presubmission";
import { evaluateClientRules } from "@/lib/services/payors";
import {
  approveSection,
  createPlan,
  draftSection,
  editSection,
  planView,
  setSectionItem,
  updateGoal,
} from "@/lib/services/plans";
import { AS_OF, client } from "../helpers/synthetic-eval";
import { clientId, ctxAs } from "../helpers/ctx";

const bcba = ctxAs("BCBA");
let planId: string;

beforeAll(async () => {
  planId = (await createPlan(bcba, clientId("client2"), "reauth")).id;
  // Goals are shared across a client's plans; start from no flat-progress explanation.
  await withOrg(bcba, (tx) =>
    tx.goal.updateMany({ where: { clientId: clientId("client2") }, data: { flatExplanation: null } }),
  );
});
afterEach(() => setLlmProvider(null));

async function auditFor(pid: string) {
  return withOrg(bcba, async (tx) => {
    const b = await loadPlanBundle(tx, pid);
    const { results } = await evaluateClientRules(tx, b.client.id, AS_OF, pid);
    return runPresubmissionAudit(b, buildSourcedContext(b, AS_OF), results, AS_OF);
  });
}

describe("plan creation", () => {
  it("creates the 23 sections, attaches goals, and records payor document versions", async () => {
    const v = await planView(bcba, planId, AS_OF);
    expect(v.sections).toHaveLength(23);
    expect(v.sections.every((s) => s.state === "draft")).toBe(true);
    expect(v.goals).toHaveLength(9);
    const docs = v.bundle.plan.payorDocVersions as { name: string; version: string }[];
    expect(
      docs.some((d) => /Evernorth ABA Prior Authorization Form/.test(d.name) && d.version === "Rev. 08/2021"),
    ).toBe(true);
  });
});

describe("AI drafting through the single LLM module", () => {
  it("drafts with tokens only, audits the call, and never sends identifiers or restricted fields", async () => {
    const mock = new MockProvider();
    setLlmProvider(mock);
    const r = await draftSection(bcba, planId, "assessment_results", AS_OF);
    expect(r.text).toMatch(/\{\{client\.name\}\}/);
    expect(r.text).toMatch(/\{\{score\.total\.admin2\}\}/);
    const sent = mock.calls.map((c) => c.system + c.user).join("\n");
    for (const banned of [
      "Bravo",
      "Testchild",
      "Jordan",
      "SYN-CIG-000202",
      client("client2").dob,
      "abuse_history",
      "custody_arrangement",
      "family_psychiatric_history",
    ])
      expect(sent).not.toContain(banned);
    // Values never go to the model, only keys and labels.
    expect(sent).not.toMatch(/"value"\s*:/);
    const rows = await withOrg(bcba, (tx) =>
      tx.auditEvent.findMany({ where: { action: "ai:call" }, orderBy: { createdAt: "desc" }, take: 1 }),
    );
    expect(rows[0]!.meta).toMatchObject({
      model: "mock-model",
      section: "assessment_results",
      outcome: "ok",
      attempt: 1,
    });
    expect((rows[0]!.meta as { promptHash: string }).promptHash).toMatch(/^[0-9a-f]{64}$/);
    expect(rows[0]!.userId).toBe(bcba.userId);
  });

  it("rejects digits, retries once, then surfaces the error to the BCBA", async () => {
    setLlmProvider(new MockProvider(["[Client] scored 92 points.", "Still has 3 numbers."]));
    await expect(draftSection(bcba, planId, "biopsychosocial", AS_OF)).rejects.toBeInstanceOf(
      AiFirewallError,
    );
    const rows = await withOrg(bcba, (tx) =>
      tx.auditEvent.findMany({ where: { action: "ai:call" }, orderBy: { createdAt: "desc" }, take: 2 }),
    );
    expect(rows.map((r) => (r.meta as { outcome: string }).outcome)).toEqual([
      "firewall_rejected",
      "firewall_rejected",
    ]);
  });

  it("accepts the retry when the second attempt is valid; rejects unknown keys", async () => {
    setLlmProvider(
      new MockProvider([
        "Total was {{score.total.admin9}}.",
        "[Client] is authorized for {{auth.97153.hours_per_week}} weekly.",
      ]),
    );
    const r = await draftSection(bcba, planId, "service_recommendations", AS_OF);
    expect(r.attempts).toBe(2);
    expect(r.text).toBe("{{client.name}} is authorized for {{auth.97153.hours_per_week}} weekly.");
    // The draft response carries the rendered text, so the page can show it at once.
    expect(r.html).toContain(">40 hours<");
    const v = await planView(bcba, planId, AS_OF);
    const html = v.sections.find((s) => s.key === "service_recommendations")!.html;
    expect(html).toContain('data-key="auth.97153.hours_per_week"');
    // Hour values render with their unit, so the model never writes "1 hours".
    expect(html).toContain(">40 hours<");
    expect(html).toMatch(
      /title="Approved 97153 hours per week in the current authorization \(renders with its unit[^"]*Source: Authorization SYN-AUTH-2002, 97153/,
    );
  });

  it("labels the current authorization and adds the requested period start on a reauth", async () => {
    const v = await planView(bcba, planId, AS_OF);
    const get = (k: string) => v.sourced.find((x) => x.key === k);
    const end = get("auth.end")!;
    expect(end.label).toMatch(/^Current authorization end date/);
    const next = get("auth.requested_start")!;
    expect(next.label).toMatch(/Requested \(next\) authorization period start date/);
    const d = new Date(`${end.value}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + 1);
    expect(next.value).toBe(d.toISOString().slice(0, 10));
    // No requested end date is invented.
    expect(v.sourced.some((x) => x.key.startsWith("auth.requested_end"))).toBe(false);
    const caregiver = get("auth.97156.hours_per_week")!;
    expect(caregiver.display).toMatch(/^\d+(\.\d)? hours?$/);
  });

  it("sends every diagnosis, the reauth context, other section titles, and narrowed goal figures", async () => {
    const mock = new MockProvider();
    setLlmProvider(mock);
    await draftSection(bcba, planId, "diagnosis_and_referral", AS_OF);
    const dxPayload = JSON.parse(mock.calls.at(-1)!.user) as {
      availableValues: { key: string; label: string; facts?: string[] }[];
      otherSections: string[];
      requestContext: string;
    };
    const dxKeys = dxPayload.availableValues.map((x) => x.key);
    expect(dxKeys).toEqual(expect.arrayContaining(["dx.1.icd10", "dx.1.label", "dx.2.icd10", "dx.2.label"]));
    expect(dxPayload.availableValues.find((x) => x.key === "dx.2.icd10")!.facts).toEqual([
      "co-occurring diagnosis",
    ]);
    expect(dxPayload.otherSections).toContain("Crisis and Safety Plan");
    expect(dxPayload.otherSections).not.toContain("Diagnosis, Referral, and Diagnostic Evaluation");
    expect(dxPayload.requestContext).toMatch(/^Reauthorization/);
    expect(mock.calls.at(-1)!.system).toMatch(/\[BCBA: add/);
    expect(mock.calls.at(-1)!.system).toMatch(/never address the BCBA/);

    // Behavior reduction sees only its own goals' figures; the BIP sees none.
    await draftSection(bcba, planId, "behavior_reduction_goals", AS_OF);
    const red = JSON.parse(mock.calls.at(-1)!.user) as {
      availableValues: { key: string }[];
      goals: { goalNumber: string; objective?: string }[];
    };
    const redGoals = new Set(red.goals.map((g) => `${g.goalNumber}.`));
    const goalKeys = red.availableValues.map((x) => x.key).filter((k) => k.startsWith("goal."));
    expect(goalKeys.length).toBeGreaterThan(0);
    for (const k of goalKeys)
      expect(
        [...redGoals].some((p) => k.startsWith(p)),
        k,
      ).toBe(true);
    expect(red.goals.every((g) => typeof g.objective === "string")).toBe(true);

    await draftSection(bcba, planId, "behavior_intervention_plan", AS_OF);
    const bip = JSON.parse(mock.calls.at(-1)!.user) as {
      availableValues: { key: string }[];
      goals: { objective?: string }[];
    };
    expect(bip.availableValues.some((x) => x.key.startsWith("goal."))).toBe(false);
    expect(bip.goals.length).toBeGreaterThan(0);
    expect(bip.goals.some((g) => "objective" in g)).toBe(false);

    await draftSection(bcba, planId, "medical_necessity", AS_OF);
    const mn = JSON.parse(mock.calls.at(-1)!.user) as { availableValues: { key: string }[] };
    expect(mn.availableValues.some((x) => /^(goal|score)\./.test(x.key))).toBe(false);
  });

  it("sends aggression to the crisis plan as a safety flag and intake answer, never restricted fields", async () => {
    const mock = new MockProvider();
    setLlmProvider(mock);
    await draftSection(bcba, planId, "crisis_plan", AS_OF);
    const call = mock.calls.at(-1)!;
    const payload = JSON.parse(call.user) as {
      staffSafetyFlags: string[];
      intake: { fields: Record<string, unknown> };
      availableValues: { key: string }[];
    };
    expect(payload.staffSafetyFlags).toContain("Aggression toward others (moderate)");
    expect(payload.intake.fields.aggression).toBeDefined();
    expect(payload.availableValues.map((x) => x.key)).toContain("intake.aggression_frequency.count");
    expect(call.user).not.toContain("suicidal_behavior");
  });

  it("drops a possessive or 'the' put before the caregiver value", async () => {
    setLlmProvider(
      new MockProvider([
        "[Client]'s [Caregiver] attends sessions. The [Caregiver] practices daily, as reported by the {{caregiver.primary}}.",
      ]),
    );
    const r = await draftSection(bcba, planId, "transition_fade_plan", AS_OF);
    expect(r.text).toBe(
      "{{caregiver.primary}} attends sessions. {{caregiver.primary}} practices daily, as reported by {{caregiver.primary}}.",
    );
    expect(r.html).not.toContain('data-key="client.name"');
  });
});

describe("section workflow", () => {
  it("RBT cannot approve (403); BCBA cannot approve with open required items (422)", async () => {
    await expect(approveSection(ctxAs("RBT"), planId, "assessment_results", AS_OF)).rejects.toBeInstanceOf(
      ForbiddenError,
    );
    await expect(
      approveSection(ctxAs("AUTH_COORDINATOR"), planId, "assessment_results", AS_OF),
    ).rejects.toMatchObject({ status: 403 });
    await expect(approveSection(bcba, planId, "assessment_results", AS_OF)).rejects.toMatchObject({
      status: 422,
    });
  });

  it("draft → edited → approved, storing the AI-vs-final diff", async () => {
    setLlmProvider(new MockProvider());
    await draftSection(bcba, planId, "assessment_results", AS_OF);
    await editSection(
      bcba,
      planId,
      "assessment_results",
      "{{client.name}} completed the VB-MAPP on {{vbmapp.admin2.date}} with a total of {{score.total.admin2}}.",
      AS_OF,
    );
    for (const item of ["assessment_dates", "isolated_scores_verified"])
      await setSectionItem(
        bcba,
        planId,
        "assessment_results",
        item,
        item === "isolated_scores_verified" ? "none" : "answered",
      );
    const v0 = await planView(bcba, planId, AS_OF);
    const open = v0.sections
      .find((s) => s.key === "assessment_results")!
      .items.filter((i) => i.status === null);
    for (const i of open) await setSectionItem(bcba, planId, "assessment_results", i.key, "answered");
    const s = await approveSection(bcba, planId, "assessment_results", AS_OF);
    expect(s.state).toBe("approved");
    const revs = await withOrg(bcba, (tx) =>
      tx.planSectionRevision.findMany({ where: { sectionId: s.id }, orderBy: { createdAt: "asc" } }),
    );
    expect(revs.map((r) => r.kind)).toEqual(expect.arrayContaining(["ai_draft", "edit", "approve"]));
    expect(revs.find((r) => r.kind === "approve")!.diff).toMatch(/^[-+] /m);
    await expect(editSection(bcba, planId, "assessment_results", "x", AS_OF)).rejects.toMatchObject({
      status: 409,
    });
  });

  it("rejects unknown tokens in BCBA edits", async () => {
    await expect(
      editSection(bcba, planId, "biopsychosocial", "Score {{made.up}}", AS_OF),
    ).rejects.toBeInstanceOf(HttpError);
  });
});

describe("pre-submission audit", () => {
  it("Client 2: flags the flat goal and the data gaps", async () => {
    const checks = await auditFor(planId);
    const flat = checks.find((c) => c.id === "progress.flat.3")!;
    expect(flat.status).toBe("fail");
    expect(flat.message).toMatch(/Listener/);
    const gaps = checks.find((c) => c.id === "graph.gaps.4")!;
    expect(gaps.status).toBe("warn");
    expect(gaps.details!.length).toBeGreaterThanOrEqual(2);
    // Only the flat goal is flagged as flat.
    expect(checks.filter((c) => c.id.startsWith("progress.flat.")).map((c) => c.id)).toEqual([
      "progress.flat.3",
    ]);
    expect(checks.find((c) => c.id === "goals.duplicate_rationale")!.status).toBe("pass");
    expect(checks.find((c) => c.id === "goals.dx_link")!.status).toBe("pass");
  });

  it("a BCBA explanation clears the flat-progress block", async () => {
    const v = await planView(bcba, planId, AS_OF);
    await updateGoal(bcba, v.goals.find((g) => g.ordinal === 3)!.id, {
      flatExplanation: "Plateau after a program change; teaching procedure revised to add visual supports.",
    });
    expect((await auditFor(planId)).find((c) => c.id === "progress.flat.3")!.status).toBe("pass");
  });

  it("Client 3: flags caregiver training below the TRICARE minimum", async () => {
    const p3 = await createPlan(bcba, clientId("client3"), "reauth");
    const checks = await auditFor(p3.id);
    const cg = checks.filter((c) => c.category === "Caregiver training");
    expect(cg).toHaveLength(1);
    expect(cg[0]!.message).toMatch(/Caregiver training below payor minimum: 97156.*\(unverified rule\)/);
    expect(cg[0]!.status).toBe("warn"); // unverified rules never block
    expect(checks.find((c) => c.id === "universal.secondary")!.status).toBe("fail");
  });
});

describe("drafting outside the database transaction", () => {
  it("refuses a second draft of the same section while one is running, and never overwrites an edit", async () => {
    const slow = {
      name: "slow-mock",
      model: "slow-mock",
      async complete() {
        await new Promise((r) => setTimeout(r, 400));
        return { text: "A short draft about {{client.name}}.", model: "slow-mock" };
      },
    };
    setLlmProvider(slow as never);
    const p = await createPlan(bcba, clientId("client2"), "reauth");
    const first = draftSection(bcba, p.id, "barriers_to_treatment", AS_OF);
    await expect(draftSection(bcba, p.id, "barriers_to_treatment", AS_OF)).rejects.toMatchObject({
      status: 409,
    });
    await first;
    // Edited while the model is writing: the late draft is not saved.
    const late = draftSection(bcba, p.id, "barriers_to_treatment", AS_OF);
    await new Promise((r) => setTimeout(r, 100));
    await editSection(bcba, p.id, "barriers_to_treatment", "BCBA text.", AS_OF);
    await expect(late).rejects.toMatchObject({ status: 409 });
    const v = await planView(bcba, p.id, AS_OF);
    expect(v.sections.find((s) => s.key === "barriers_to_treatment")!.content).toBe("BCBA text.");
  });
});
