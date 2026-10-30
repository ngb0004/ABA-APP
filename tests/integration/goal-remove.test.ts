import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { MockProvider, setLlmProvider } from "@/lib/ai";
import type { LlmRequest, LlmResponse } from "@/lib/ai/provider";
import { withOrg } from "@/lib/db";
import { ForbiddenError } from "@/lib/log";
import { buildSourcedContext, loadPlanBundle } from "@/lib/plan/context";
import { buildDraftPayload } from "@/lib/plan/drafting";
import { SECTION_BY_KEY } from "@/lib/plan/sections";
import { validateBcbaText } from "@/lib/firewall";
import { pseudonymNames } from "@/lib/intake/derive";
import { REMOVED_GOAL_PLACEHOLDER } from "@/lib/goals/renumber";
import { goalsView } from "@/lib/services/goals";
import { addGoalFromTemplate } from "@/lib/services/misc";
import { packetHtml } from "@/lib/services/packets";
import {
  approveSection,
  createPlan,
  discontinueGoal,
  draftSection,
  editSection,
  removeGoal,
  reopenSection,
  resumeGoal,
  setSectionItem,
  updateGoal,
} from "@/lib/services/plans";
import { addDataPoint, createClient } from "@/lib/services/records";
import { AS_OF, dataset } from "../helpers/synthetic-eval";
import { ctxAs } from "../helpers/ctx";

const bcba = ctxAs("BCBA");
const other = dataset.orgs[1]!;
const otherBcba = { orgId: other.id, userId: other.users[0]!.id, role: "BCBA" as const };

const fictional = (lastName: string) => ({
  firstName: "Robin",
  lastName,
  dob: "2021-04-02",
  serviceAddress: { line1: "1 Fiction Ln", city: "Example City", state: "GA", zip: "30000" },
  guardians: [{ name: "Pat Testcase", relationship: "mother", legalCustody: true, canSign: true }],
  fictional: true,
});

let templates: { id: string; category: string }[];
const tpl = (category: string, n = 0) => templates.filter((t) => t.category === category)[n]!.id;

async function newClientWithGoals(lastName: string, categories: string[]) {
  const cid = (await createClient(bcba, fictional(lastName), AS_OF)).id;
  const goals = [];
  for (const [i, c] of categories.entries()) goals.push(await addGoalFromTemplate(bcba, cid, tpl(c, i % 3)));
  return { cid, goals };
}

const goalsOf = (cid: string) =>
  withOrg(bcba, (tx) => tx.goal.findMany({ where: { clientId: cid }, orderBy: { ordinal: "asc" } }));

const auditRows = (action: string, entityId: string) =>
  withOrg(bcba, (tx) => tx.auditEvent.findMany({ where: { action, entityId } }));

afterEach(() => setLlmProvider(null));

const sectionOf = (planId: string, key: string) =>
  withOrg(bcba, (tx) => tx.planSection.findUniqueOrThrow({ where: { planId_key: { planId, key } } }));

beforeAll(async () => {
  templates = await withOrg(bcba, (tx) =>
    tx.goalTemplate.findMany({ orderBy: [{ domainNumber: "asc" }, { tier: "asc" }] }),
  );
});

describe("removing a goal added by mistake", () => {
  it("removes a fresh goal, cleans its phase lines and replacement links, and audits domain/category only", async () => {
    const { cid, goals } = await newClientWithGoals("Removeone", ["communication", "behavior_reduction"]);
    const [g1, g2] = goals as [(typeof goals)[0], (typeof goals)[0]];
    await withOrg(bcba, async (tx) => {
      await tx.goalPhaseChange.create({
        data: { orgId: bcba.orgId, goalId: g1.id, date: new Date("2026-10-01"), label: "Mistaken phase" },
      });
      await tx.goal.update({ where: { id: g2.id }, data: { replacementForGoalId: g1.id } });
    });
    const view = await goalsView(bcba, cid, AS_OF);
    expect(view.goals.find((g) => g.id === g1.id)!.removeBlocker).toBeNull();

    await removeGoal(bcba, g1.id);
    const left = await goalsOf(cid);
    expect(left.map((g) => g.id)).toEqual([g2.id]);
    expect(left[0]!.replacementForGoalId).toBeNull();
    const phases = await withOrg(bcba, (tx) => tx.goalPhaseChange.findMany({ where: { goalId: g1.id } }));
    expect(phases).toEqual([]);
    const [row] = await auditRows("goal:remove", g1.id);
    expect(row).toBeDefined();
    expect(row!.meta).toMatchObject({ domain: g1.domain, category: g1.category });
    expect(JSON.stringify(row!.meta)).not.toMatch(/Robin|Removeone|objective/i);
  });

  it("refuses (409) once the goal has data, a locked baseline, or an approval, and the page hides Remove", async () => {
    const { cid, goals } = await newClientWithGoals("Removerefused", [
      "communication",
      "communication",
      "other",
    ]);
    const [withData, approved, plain] = goals as [(typeof goals)[0], (typeof goals)[0], (typeof goals)[0]];
    await addDataPoint(bcba, withData.id, { date: "2026-10-01", value: 40 }, AS_OF);
    await withOrg(bcba, (tx) =>
      tx.goal.update({ where: { id: approved.id }, data: { status: "approved", approvedAt: new Date() } }),
    );
    await expect(removeGoal(bcba, withData.id)).rejects.toMatchObject({
      status: 409,
      message: "This goal has data, so it can't be removed. Discontinue it instead.",
    });
    await expect(removeGoal(bcba, approved.id)).rejects.toMatchObject({ status: 409 });
    const view = await goalsView(bcba, cid, AS_OF);
    const blocker = (id: string) => view.goals.find((g) => g.id === id)!.removeBlocker;
    expect(blocker(withData.id)).toMatch(/has data/);
    expect(blocker(approved.id)).toMatch(/approved/);
    expect(blocker(plain.id)).toBeNull();
    expect((await goalsOf(cid)).length).toBe(3);
  });

  it("refuses a goal whose baseline is locked", async () => {
    const { goals } = await newClientWithGoals("Removelocked", ["communication"]);
    const g = goals[0]!;
    // A locked baseline without data cannot happen through the app; the rule still refuses it.
    await withOrg(bcba, (tx) =>
      tx.goal.update({
        where: { id: g.id },
        data: {
          baselineValue: 20,
          baselineDate: new Date("2026-09-01"),
          baselineLockedAt: new Date(),
          baselineLockedById: bcba.userId,
        },
      }),
    );
    await expect(removeGoal(bcba, g.id)).rejects.toMatchObject({
      status: 409,
      message: /baseline is locked/,
    });
  });

  it("refuses a goal that was in an approved section or an exported packet", async () => {
    const { cid, goals } = await newClientWithGoals("Removeapproved", ["communication", "other"]);
    const plan = await createPlan(bcba, cid, "initial");
    const [inApproved, inPacket] = goals as [(typeof goals)[0], (typeof goals)[0]];
    // The goal summary covers every goal; it was approved while both goals existed.
    await withOrg(bcba, async (tx) => {
      const s = await tx.planSection.findUniqueOrThrow({
        where: { planId_key: { planId: plan.id, key: "goal_summary" } },
      });
      await tx.planSection.update({
        where: { id: s.id },
        data: { state: "approved", approvedAt: new Date() },
      });
      await tx.planSectionRevision.create({
        data: { orgId: bcba.orgId, sectionId: s.id, kind: "approve", content: "x", userId: bcba.userId },
      });
    });
    await expect(removeGoal(bcba, inApproved.id)).rejects.toMatchObject({
      status: 409,
      message: /approved plan section/,
    });
    // Reopening the section does not undo that it was approved with the goal in it.
    await withOrg(bcba, (tx) =>
      tx.planSection.updateMany({
        where: { planId: plan.id, key: "goal_summary" },
        data: { state: "edited" },
      }),
    );
    await expect(removeGoal(bcba, inApproved.id)).rejects.toMatchObject({ status: 409 });

    const { cid: cid2, goals: g2 } = await newClientWithGoals("Removepacket", ["communication"]);
    const plan2 = await createPlan(bcba, cid2, "initial");
    await withOrg(bcba, (tx) =>
      tx.packet.create({
        data: { orgId: bcba.orgId, planId: plan2.id, status: "ready", exportedAt: new Date() },
      }),
    );
    await expect(removeGoal(bcba, g2[0]!.id)).rejects.toMatchObject({ status: 409, message: /exported/ });
    void inPacket;
  });

  it("allows a goal added after the plan's sections were approved and its packet exported", async () => {
    const { cid } = await newClientWithGoals("Removelater", ["communication"]);
    const plan = await createPlan(bcba, cid, "initial");
    const past = new Date(Date.now() - 60_000);
    await withOrg(bcba, async (tx) => {
      const s = await tx.planSection.findUniqueOrThrow({
        where: { planId_key: { planId: plan.id, key: "goal_summary" } },
      });
      await tx.planSectionRevision.create({
        data: {
          orgId: bcba.orgId,
          sectionId: s.id,
          kind: "approve",
          content: "x",
          userId: bcba.userId,
          createdAt: past,
        },
      });
      await tx.packet.create({ data: { orgId: bcba.orgId, planId: plan.id, exportedAt: past } });
    });
    const late = await addGoalFromTemplate(bcba, cid, tpl("other"));
    await removeGoal(bcba, late.id);
    expect((await goalsOf(cid)).map((g) => g.ordinal)).toEqual([1]);
  });

  it("renumbers later goals and their tokens, and flags drafted sections for redraft (never approving them)", async () => {
    const { cid, goals } = await newClientWithGoals("Removerenumber", [
      "communication",
      "communication",
      "other",
    ]);
    const [, g2, g3] = goals as [(typeof goals)[0], (typeof goals)[0], (typeof goals)[0]];
    expect(g3.rationale + g3.objective).toMatch(/\{\{goal\.3\./);
    const plan = await createPlan(bcba, cid, "initial");
    const content =
      "Goal one {{goal.1.mastery_pct}}; goal two {{goal.2.mastery_pct}}; goal three {{goal.3.mastery_pct}}.";
    await editSection(bcba, plan.id, "skill_acquisition_goals", content, AS_OF);
    const sid = (
      await withOrg(bcba, (tx) =>
        tx.planSection.findUniqueOrThrow({
          where: { planId_key: { planId: plan.id, key: "skill_acquisition_goals" } },
        }),
      )
    ).id;

    await removeGoal(bcba, g2.id);
    const left = await goalsOf(cid);
    expect(left.map((g) => g.ordinal)).toEqual([1, 2]);
    const moved = left.find((g) => g.id === g3.id)!;
    expect(moved.ordinal).toBe(2);
    expect(moved.objective + moved.rationale).not.toMatch(/\{\{goal\.3\./);
    expect(moved.objective).toMatch(/\{\{goal\.2\.mastery_pct\}\}/);

    const s = await withOrg(bcba, (tx) => tx.planSection.findUniqueOrThrow({ where: { id: sid } }));
    expect(s.content).toBe(
      `Goal one {{goal.1.mastery_pct}}; goal two ${REMOVED_GOAL_PLACEHOLDER}; goal three {{goal.2.mastery_pct}}.`,
    );
    expect(s.state).toBe("edited");
    expect(s.redraftReason).toMatch(/goal this section covered was removed/);
    // Every remaining token still renders against the renumbered goals.
    const b = await withOrg(bcba, (tx) => loadPlanBundle(tx, plan.id));
    expect(validateBcbaText(s.content, buildSourcedContext(b, AS_OF)).ok).toBe(true);
    // It cannot be approved until the BCBA redrafts or edits it.
    await expect(approveSection(bcba, plan.id, "skill_acquisition_goals", AS_OF)).rejects.toMatchObject({
      status: 422,
      message: /goal this section covered was removed/,
    });
    await editSection(bcba, plan.id, "skill_acquisition_goals", "Goal two {{goal.2.mastery_pct}}.", AS_OF);
    const s2 = await withOrg(bcba, (tx) => tx.planSection.findUniqueOrThrow({ where: { id: sid } }));
    expect(s2.redraftReason).toBeNull();
    const [row] = await auditRows("goal:remove", g2.id);
    expect(row!.meta).toMatchObject({ renumbered: 1, sectionsToRedraft: expect.any(Number) });
  });

  it("refuses when renumbering would change an approved section that refers to a later goal", async () => {
    const { cid, goals } = await newClientWithGoals("Removeshift", ["communication", "behavior_reduction"]);
    const [g1] = goals as [(typeof goals)[0]];
    const plan = await createPlan(bcba, cid, "initial");
    // Approved (before goal 1 existed is impossible here), but refers to goal 2 by number.
    await withOrg(bcba, (tx) =>
      tx.planSection.updateMany({
        where: { planId: plan.id, key: "crisis_plan" },
        data: { state: "approved", content: "See {{goal.2.mastery_pct}}." },
      }),
    );
    await expect(removeGoal(bcba, g1.id)).rejects.toMatchObject({ status: 409, message: /later goal/ });
  });

  it("is not blocked by a packet submitted before the goal existed (the usual reauth)", async () => {
    const { cid } = await newClientWithGoals("Removereauth", ["communication"]);
    const initial = await createPlan(bcba, cid, "initial");
    const march = new Date(Date.now() - 200 * 86_400_000);
    await withOrg(bcba, (tx) =>
      tx.packet.create({
        data: {
          orgId: bcba.orgId,
          planId: initial.id,
          status: "submitted",
          exportedAt: march,
          submittedAt: march,
        },
      }),
    );
    const mistake = await addGoalFromTemplate(bcba, cid, tpl("other"));
    const view = await goalsView(bcba, cid, AS_OF);
    expect(view.goals.find((g) => g.id === mistake.id)!.removeBlocker).toBeNull();
    await removeGoal(bcba, mistake.id);
    expect((await goalsOf(cid)).length).toBe(1);

    // A submitted packet with no recorded time still blocks (it may have included the goal).
    const { cid: cid2, goals } = await newClientWithGoals("Removesubmitted", ["communication"]);
    const plan2 = await createPlan(bcba, cid2, "initial");
    await withOrg(bcba, (tx) =>
      tx.packet.create({ data: { orgId: bcba.orgId, planId: plan2.id, status: "submitted" } }),
    );
    await expect(removeGoal(bcba, goals[0]!.id)).rejects.toMatchObject({ status: 409, message: /exported/ });
  });

  it("renumbers references in earlier goals too, and sends a goal that cited the removed one back for approval", async () => {
    const { cid, goals } = await newClientWithGoals("Removeearlier", [
      "communication",
      "communication",
      "other",
      "other",
    ]);
    const [g1, g2, g3, g4] = goals as [
      (typeof goals)[0],
      (typeof goals)[0],
      (typeof goals)[0],
      (typeof goals)[0],
    ];
    await withOrg(bcba, async (tx) => {
      await tx.goal.update({
        where: { id: g1.id },
        data: { barriers: "Compare {{goal.4.mastery_pct}}.", status: "approved", approvedAt: new Date() },
      });
      await tx.goal.update({
        where: { id: g2.id },
        data: { rationale: "Builds on {{goal.3.mastery_pct}}.", status: "approved", approvedAt: new Date() },
      });
    });
    await removeGoal(bcba, g3.id);
    const left = await goalsOf(cid);
    expect(left.map((g) => [g.id, g.ordinal])).toEqual([
      [g1.id, 1],
      [g2.id, 2],
      [g4.id, 3],
    ]);
    const n1 = left[0]!;
    const n2 = left[1]!;
    // Still the same goal record (old goal 4, now goal 3); the goal stays approved.
    expect(n1.barriers).toBe("Compare {{goal.3.mastery_pct}}.");
    expect(n1.status).toBe("approved");
    // It referred to the removed goal: a placeholder, and back to draft.
    expect(n2.rationale).toBe(`Builds on ${REMOVED_GOAL_PLACEHOLDER}.`);
    expect(n2.status).toBe("draft");
  });

  it("renumbers and flags not-applicable sections, so a reopened one cannot be approved as is", async () => {
    const { cid, goals } = await newClientWithGoals("Removena", ["communication", "communication", "other"]);
    const plan = await createPlan(bcba, cid, "initial");
    await withOrg(bcba, (tx) =>
      tx.planSection.updateMany({
        where: { planId: plan.id, key: "crisis_plan" },
        data: { state: "not_applicable", content: "See {{goal.3.mastery_pct}}." },
      }),
    );
    await removeGoal(bcba, goals[1]!.id);
    const s = await sectionOf(plan.id, "crisis_plan");
    expect(s.state).toBe("not_applicable");
    expect(s.content).toBe("See {{goal.2.mastery_pct}}.");
    expect(s.redraftReason).toMatch(/goal this section covered was removed/);
    await reopenSection(bcba, plan.id, "crisis_plan");
    await expect(approveSection(bcba, plan.id, "crisis_plan", AS_OF)).rejects.toMatchObject({
      status: 422,
      message: /goal this section covered was removed/,
    });
  });

  it("does not save an AI draft written while a goal was removed", async () => {
    const { cid, goals } = await newClientWithGoals("Removeinflight", ["communication", "other"]);
    const plan = await createPlan(bcba, cid, "initial");
    const before = await sectionOf(plan.id, "goal_summary");
    expect(before.content.trim()).toBe("");
    class RemovesMidway extends MockProvider {
      override async complete(req: LlmRequest): Promise<LlmResponse> {
        await removeGoal(bcba, goals[0]!.id);
        return super.complete(req);
      }
    }
    setLlmProvider(new RemovesMidway());
    await expect(draftSection(bcba, plan.id, "goal_summary", AS_OF)).rejects.toMatchObject({
      status: 409,
      message: /goals changed/,
    });
    expect((await sectionOf(plan.id, "goal_summary")).content).toBe(before.content);
    expect((await goalsOf(cid)).length).toBe(1);
  });

  it("keeps the redraft mark out of reach of the section checklist", async () => {
    const { cid, goals } = await newClientWithGoals("Removeitems", ["communication", "other"]);
    const plan = await createPlan(bcba, cid, "initial");
    await editSection(bcba, plan.id, "skill_acquisition_goals", "Goal two {{goal.2.mastery_pct}}.", AS_OF);
    await removeGoal(bcba, goals[0]!.id);
    for (const itemKey of ["_needs_redraft", "_not_applicable"])
      await expect(
        setSectionItem(bcba, plan.id, "skill_acquisition_goals", itemKey, null),
      ).rejects.toMatchObject({ status: 422 });
    const s = await sectionOf(plan.id, "skill_acquisition_goals");
    expect(s.redraftReason).toMatch(/goal this section covered was removed/);
  });

  it("is BCBA only, and another practice cannot see the goal", async () => {
    const { cid, goals } = await newClientWithGoals("Removeperm", ["communication"]);
    for (const role of ["RBT", "PARENT", "AUTH_COORDINATOR"] as const)
      await expect(removeGoal(ctxAs(role), goals[0]!.id)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(removeGoal(otherBcba, goals[0]!.id)).rejects.toThrow();
    expect((await goalsOf(cid)).length).toBe(1);
  });
});

describe("discontinuing and resuming a goal", () => {
  it("records the date and reason, keeps the data, audits, and resumes", async () => {
    const { cid, goals } = await newClientWithGoals("Discontinue", ["communication", "other"]);
    const g = goals[0]!;
    await addDataPoint(bcba, g.id, { date: "2026-10-01", value: 40 }, AS_OF);
    await discontinueGoal(bcba, g.id, { reason: "Family priorities changed.", date: "2026-10-15" }, AS_OF);
    let rec = (await goalsOf(cid))[0]!;
    expect(rec.progressStatus).toBe("discontinued");
    expect(rec.discontinuedOn?.toISOString().slice(0, 10)).toBe("2026-10-15");
    expect(rec.discontinuedReason).toBe("Family priorities changed.");
    const pts = await withOrg(bcba, (tx) => tx.goalDataPoint.count({ where: { goalId: g.id } }));
    expect(pts).toBe(1);
    expect(await auditRows("goal:discontinue", g.id)).toHaveLength(1);
    const [row] = await auditRows("goal:discontinue", g.id);
    expect(JSON.stringify(row!.meta)).not.toMatch(/Family priorities/);
    expect(row!.meta).toMatchObject({ discontinuedOn: "2026-10-15" });
    await expect(
      discontinueGoal(bcba, g.id, { reason: "Again", date: "2026-10-16" }, AS_OF),
    ).rejects.toMatchObject({ status: 409 });

    await resumeGoal(bcba, g.id);
    rec = (await goalsOf(cid))[0]!;
    expect(rec.progressStatus).toBe("in_progress");
    expect(rec.discontinuedOn).toBeNull();
    expect(rec.discontinuedReason).toBeNull();
    const resumed = await auditRows("goal:resume", g.id);
    expect(resumed).toHaveLength(1);
    expect(resumed[0]!.meta).toMatchObject({ discontinuedOn: "2026-10-15", reasonHash: expect.any(String) });
    expect(JSON.stringify(resumed[0]!.meta)).not.toMatch(/Family priorities/);
    await expect(resumeGoal(bcba, g.id)).rejects.toMatchObject({ status: 409 });
  });

  it("validates the reason and date", async () => {
    const { goals } = await newClientWithGoals("Discontinuebad", ["communication"]);
    const id = goals[0]!.id;
    await expect(
      discontinueGoal(bcba, id, { reason: "   ", date: "2026-10-15" }, AS_OF),
    ).rejects.toMatchObject({
      status: 422,
    });
    await expect(
      discontinueGoal(bcba, id, { reason: "x".repeat(501), date: "2026-10-15" }, AS_OF),
    ).rejects.toMatchObject({ status: 422 });
    await expect(
      discontinueGoal(bcba, id, { reason: "Ok", date: "2099-01-01" }, AS_OF),
    ).rejects.toMatchObject({
      status: 422,
    });
    await expect(
      discontinueGoal(bcba, id, { reason: "See {{goal.1.mastery_pct}}", date: "2026-10-15" }, AS_OF),
    ).rejects.toMatchObject({ status: 422 });
    // The status dropdown cannot discontinue (it needs a reason) or silently resume.
    await expect(updateGoal(bcba, id, { progressStatus: "discontinued" })).rejects.toMatchObject({
      status: 422,
    });
  });

  it("refuses a date introduced after the date discontinued", async () => {
    const { goals } = await newClientWithGoals("Discontinueintro", ["communication"]);
    const id = goals[0]!.id;
    await discontinueGoal(bcba, id, { reason: "Not needed now.", date: "2026-10-21" }, AS_OF);
    await expect(updateGoal(bcba, id, { introducedAt: "2026-10-25" })).rejects.toMatchObject({
      status: 422,
      message: /introduced cannot be after the date discontinued/,
    });
    await updateGoal(bcba, id, { introducedAt: "2026-10-21" });
  });

  it("is BCBA only and isolated by practice", async () => {
    const { goals } = await newClientWithGoals("Discontinueperm", ["communication"]);
    const id = goals[0]!.id;
    const body = { reason: "Not needed", date: "2026-10-15" };
    for (const role of ["RBT", "PARENT"] as const)
      await expect(discontinueGoal(ctxAs(role), id, body, AS_OF)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(resumeGoal(ctxAs("RBT"), id)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(discontinueGoal(otherBcba, id, body, AS_OF)).rejects.toThrow();
  });

  it("reports the goal as discontinued with a date token and the BCBA's reason, never sent to the AI", async () => {
    const { cid, goals } = await newClientWithGoals("Discontinuereport", ["communication"]);
    for (const [date, value] of [
      ["2026-09-01", 20],
      ["2026-09-08", 30],
      ["2026-09-15", 35],
    ] as const)
      await addDataPoint(bcba, goals[0]!.id, { date, value }, AS_OF);
    const plan = await createPlan(bcba, cid, "reauth");
    await discontinueGoal(
      bcba,
      goals[0]!.id,
      { reason: "Replaced by a broader goal.", date: "2026-10-15" },
      AS_OF,
    );
    const b = await withOrg(bcba, (tx) => loadPlanBundle(tx, plan.id));
    const sourced = buildSourcedContext(b, AS_OF);
    expect(sourced.get("goal.1.discontinued_on")?.value).toBe("2026-10-15");
    expect(sourced.get("goals.count.discontinued")?.value).toBe(1);
    expect(
      validateBcbaText("Goal one was discontinued on {{goal.1.discontinued_on}}.", sourced).unsourcedNumbers,
    ).toEqual([]);
    const payload = buildDraftPayload({
      def: SECTION_BY_KEY.get("goal_summary")!,
      bundle: b,
      sourced,
      names: pseudonymNames(b.client),
    });
    expect(JSON.stringify(payload)).not.toMatch(/Replaced by a broader goal/);
    expect(JSON.stringify(payload)).toMatch(/goal\.1\.discontinued_on/);
    const html = packetHtml(b, [], AS_OF);
    expect(html).toMatch(/Discontinued/);
    expect(html).toMatch(/Replaced by a broader goal\./);
  });
});
