import { beforeAll, describe, expect, it } from "vitest";
import { withOrg } from "@/lib/db";
import {
  ApproveGoalSchema,
  GOAL_CHANGED_BEFORE_APPROVAL,
  GOAL_CHANGED_ELSEWHERE,
  GoalPatchSchema,
} from "@/lib/goals/goal-patch";
import { HttpError } from "@/lib/log";
import { addGoalFromTemplate } from "@/lib/services/misc";
import { approveGoal, discontinueGoal, resumeGoal, updateGoal } from "@/lib/services/plans";
import { createClient } from "@/lib/services/records";
import { AS_OF } from "../helpers/synthetic-eval";
import { ctxAs } from "../helpers/ctx";

const bcba = ctxAs("BCBA");

let templateId: string;
beforeAll(async () => {
  templateId = (
    await withOrg(bcba, (tx) => tx.goalTemplate.findFirstOrThrow({ orderBy: { domainNumber: "asc" } }))
  ).id;
});

async function newGoal(lastName: string) {
  const cid = (
    await createClient(
      bcba,
      {
        firstName: "Robin",
        lastName,
        dob: "2021-04-02",
        serviceAddress: { line1: "1 Fiction Ln", city: "Example City", state: "GA", zip: "30000" },
        guardians: [{ name: "Pat Testcase", relationship: "mother", legalCustody: true, canSign: true }],
        fictional: true,
      },
      AS_OF,
    )
  ).id;
  return addGoalFromTemplate(bcba, cid, templateId);
}

const read = (id: string) => withOrg(bcba, (tx) => tx.goal.findUniqueOrThrow({ where: { id } }));
const updates = (id: string) =>
  withOrg(bcba, (tx) => tx.auditEvent.findMany({ where: { action: "goal:update", entityId: id } }));

describe("goal autosave: partial saves checked field by field", () => {
  it("saves only the fields sent, returns the new version, and audits field names only", async () => {
    const g = await newGoal("Autosavepartial");
    const before = await read(g.id);
    const r = await updateGoal(
      bcba,
      g.id,
      { barriers: "Robin's schedule changed." },
      { base: { barriers: before.barriers } },
    );
    const after = await read(g.id);
    expect(after.barriers).toBe("Robin's schedule changed.");
    expect(after.objective).toBe(before.objective);
    expect(after.rationale).toBe(before.rationale);
    expect(after.masteryAccuracyPct).toBe(before.masteryAccuracyPct);
    expect(r.updatedAt).toBe(after.updatedAt.toISOString());
    expect(r.updatedAt).not.toBe(before.updatedAt.toISOString());
    const rows = await updates(g.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.meta).toMatchObject({ fields: ["barriers"] });
    expect(JSON.stringify(rows[0]!.meta)).not.toMatch(/Robin|schedule/);
  });

  it("refuses (409) a field someone else changed meanwhile, with the current values, and saves nothing", async () => {
    const g = await newGoal("Autosavestale");
    await updateGoal(bcba, g.id, { barriers: "First tab." }, { base: { barriers: "" } });
    const err = await updateGoal(
      bcba,
      g.id,
      { barriers: "Second tab.", rationale: "Also second tab." },
      { base: { barriers: "", rationale: g.rationale } },
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect(err).toMatchObject({
      status: 409,
      message: GOAL_CHANGED_ELSEWHERE,
      data: {
        conflict: { fields: ["barriers"], current: { barriers: "First tab.", rationale: g.rationale } },
      },
    });
    const after = await read(g.id);
    expect(after.barriers).toBe("First tab.");
    expect(after.rationale).toBe(g.rationale);
    // Based on what it holds now, the save goes through.
    await updateGoal(bcba, g.id, { barriers: "Second tab." }, { base: { barriers: "First tab." } });
    expect((await read(g.id)).barriers).toBe("Second tab.");
    // A field already holding the new value is not a conflict.
    await updateGoal(bcba, g.id, { barriers: "Second tab." }, { base: { barriers: "old" } });
    // A save still in flight when the page was left: its value is accepted as the base too.
    await updateGoal(
      bcba,
      g.id,
      { barriers: "Typed after." },
      { base: { barriers: "First tab." }, baseAlt: { barriers: "Second tab." } },
    );
    expect((await read(g.id)).barriers).toBe("Typed after.");
  });

  it("never treats the goal's bookkeeping (discontinue, approve, lock, position) as a conflict", async () => {
    const g = await newGoal("Autosavebookkeeping");
    // An editor opened before all of these, still holding the original barriers.
    const base = { barriers: "" };
    await discontinueGoal(bcba, g.id, { reason: "Paused.", date: "2026-10-20" }, AS_OF);
    await withOrg(bcba, (tx) => tx.goal.update({ where: { id: g.id }, data: { ordinal: { increment: 0 } } }));
    await updateGoal(bcba, g.id, { barriers: "After discontinuing." }, { base });
    const res = await resumeGoal(bcba, g.id);
    expect(typeof res.updatedAt).toBe("string");
    await updateGoal(bcba, g.id, { settings: ["home"] }, { base: { settings: [] } });
    const after = await read(g.id);
    // What was typed survived both.
    expect(after.barriers).toBe("After discontinuing.");
    expect(after.progressStatus).toBe("in_progress");
  });

  it("approves only what the approver was shown", async () => {
    const g = await newGoal("Autosaveapprove");
    await withOrg(bcba, (tx) =>
      tx.goal.update({
        where: { id: g.id },
        data: {
          objective: "[Client] will mand for items.",
          rationale: "Requesting matters.",
          sd: "",
          targetBehavior: "",
        },
      }),
    );
    const cur = await read(g.id);
    const shown = {
      objective: cur.objective,
      rationale: cur.rationale,
      masteryAccuracyPct: cur.masteryAccuracyPct,
      masteryConsecutiveSessions: cur.masteryConsecutiveSessions,
      masteryInstructors: cur.masteryInstructors,
      introducedAt: cur.introducedAt ? cur.introducedAt.toISOString().slice(0, 10) : null,
      projectedMasteryDate: cur.projectedMasteryDate
        ? cur.projectedMasteryDate.toISOString().slice(0, 10)
        : null,
    };
    // Someone else's half-typed rationale autosaves after the approver's page loaded.
    await updateGoal(
      bcba,
      g.id,
      { rationale: "Requesting matt" },
      { base: { rationale: "Requesting matters." } },
    );
    await expect(approveGoal(bcba, g.id, { expected: shown })).rejects.toMatchObject({
      status: 409,
      message: GOAL_CHANGED_BEFORE_APPROVAL,
    });
    expect((await read(g.id)).status).not.toBe("approved");
    // Shown the latest, it is approved.
    const a = await approveGoal(bcba, g.id, { expected: { ...shown, rationale: "Requesting matt" } });
    expect(typeof a.updatedAt).toBe("string");
    expect((await read(g.id)).status).toBe("approved");
    expect(ApproveGoalSchema.safeParse({}).success).toBe(false);
  });

  it("sends an approved goal back to draft only when what it says really changes", async () => {
    const g = await newGoal("Autosaveapproved");
    await withOrg(bcba, (tx) =>
      tx.goal.update({
        where: { id: g.id },
        data: {
          objective: "[Client] will mand for items.",
          rationale: "Requesting matters.",
          sd: "",
          targetBehavior: "",
        },
      }),
    );
    const a = await approveGoal(bcba, g.id);
    expect(typeof a.updatedAt).toBe("string");
    // Status, barriers, and settings do not need a new approval.
    const r1 = await updateGoal(bcba, g.id, { barriers: "None.", settings: ["home"] });
    expect(r1).toMatchObject({ status: "approved", returnedToDraft: false });
    // Sending the stored objective unchanged is not a change.
    const r2 = await updateGoal(bcba, g.id, { objective: "[Client] will mand for items." });
    expect(r2).toMatchObject({ status: "approved", returnedToDraft: false });
    const r3 = await updateGoal(bcba, g.id, { objective: "[Client] will mand for snacks." });
    expect(r3).toMatchObject({ status: "draft", returnedToDraft: true });
    const after = await read(g.id);
    expect(after.status).toBe("draft");
    expect(after.approvedAt).toBeNull();
    // Audit rows are not ordered within a millisecond: exactly one save returned the goal to draft.
    const drafted = (await updates(g.id)).filter(
      (u) => (u.meta as { returnedToDraft?: boolean }).returnedToDraft,
    );
    expect(drafted.map((u) => u.meta)).toEqual([{ fields: ["objective"], returnedToDraft: true }]);
  });

  it("checks values the same way as the editor before saving", () => {
    const base = { objective: "x", masteryAccuracyPct: 80, introducedAt: null, settings: [], rationale: "y" };
    expect(GoalPatchSchema.safeParse({ objective: "   ", base }).success).toBe(false);
    expect(GoalPatchSchema.safeParse({ masteryAccuracyPct: 101, base }).success).toBe(false);
    expect(GoalPatchSchema.safeParse({ introducedAt: "2026-02-30", base }).success).toBe(false);
    expect(GoalPatchSchema.safeParse({ settings: ["x".repeat(41)], base }).success).toBe(false);
    // Every field sent names what it was based on; unknown fields are refused.
    expect(GoalPatchSchema.safeParse({ barriers: "" }).success).toBe(false);
    expect(GoalPatchSchema.safeParse({ barriers: "", base: { rationale: "y" } }).success).toBe(false);
    expect(GoalPatchSchema.safeParse({ barriers: "", base: { barriers: "", nope: 1 } }).success).toBe(false);
    expect(GoalPatchSchema.parse({ rationale: "Because.", base })).toEqual({ rationale: "Because.", base });
  });
});
