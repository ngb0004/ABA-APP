import { beforeAll, describe, expect, it } from "vitest";
import { withOrg } from "@/lib/db";
import { GOAL_CHANGED_ELSEWHERE, GoalPatchSchema } from "@/lib/goals/goal-patch";
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

describe("goal autosave: partial saves with a version check", () => {
  it("saves only the fields sent, returns the new version, and audits field names only", async () => {
    const g = await newGoal("Autosavepartial");
    const before = await read(g.id);
    const r = await updateGoal(
      bcba,
      g.id,
      { barriers: "Robin's schedule changed." },
      { expectedUpdatedAt: before.updatedAt.toISOString() },
    );
    const after = await read(g.id);
    expect(after.barriers).toBe("Robin's schedule changed.");
    expect(after.objective).toBe(before.objective);
    expect(after.rationale).toBe(before.rationale);
    expect(after.masteryAccuracyPct).toBe(before.masteryAccuracyPct);
    expect(r.updatedAt).toBe(after.updatedAt.toISOString());
    expect(after.updatedAt.getTime()).toBeGreaterThanOrEqual(before.updatedAt.getTime());
    expect(r.updatedAt).not.toBe(before.updatedAt.toISOString());
    const rows = await updates(g.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.meta).toMatchObject({ fields: ["barriers"] });
    expect(JSON.stringify(rows[0]!.meta)).not.toMatch(/Robin|schedule/);
  });

  it("refuses (409) a save based on an older version and changes nothing", async () => {
    const g = await newGoal("Autosavestale");
    const v0 = (await read(g.id)).updatedAt.toISOString();
    const r1 = await updateGoal(bcba, g.id, { barriers: "First tab." }, { expectedUpdatedAt: v0 });
    await expect(
      updateGoal(bcba, g.id, { barriers: "Second tab." }, { expectedUpdatedAt: v0 }),
    ).rejects.toMatchObject({ status: 409, message: GOAL_CHANGED_ELSEWHERE });
    expect((await read(g.id)).barriers).toBe("First tab.");
    // With the version from the last save, the next one goes through.
    const r2 = await updateGoal(bcba, g.id, { barriers: "Second tab." }, { expectedUpdatedAt: r1.updatedAt });
    expect((await read(g.id)).barriers).toBe("Second tab.");
    expect(r2.updatedAt > r1.updatedAt).toBe(true);
    // Discontinue and Resume change the version too, and say what it is now.
    const d = await discontinueGoal(bcba, g.id, { reason: "Paused.", date: "2026-10-20" }, AS_OF);
    await expect(
      updateGoal(bcba, g.id, { barriers: "Stale." }, { expectedUpdatedAt: r2.updatedAt }),
    ).rejects.toMatchObject({ status: 409 });
    const u = await updateGoal(
      bcba,
      g.id,
      { barriers: "After discontinuing." },
      { expectedUpdatedAt: d.updatedAt },
    );
    const res = await resumeGoal(bcba, g.id);
    expect(res.updatedAt > u.updatedAt).toBe(true);
    const after = await read(g.id);
    // What was typed survived both.
    expect(after.barriers).toBe("After discontinuing.");
    expect(after.progressStatus).toBe("in_progress");
    await expect(
      updateGoal(bcba, g.id, { barriers: "x" }, { expectedUpdatedAt: "not a date" }),
    ).rejects.toMatchObject({ status: 409 });
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
    expect((await updates(g.id)).at(-1)!.meta).toMatchObject({
      fields: ["objective"],
      returnedToDraft: true,
    });
  });

  it("checks values the same way as the editor before saving", () => {
    expect(GoalPatchSchema.safeParse({ objective: "   " }).success).toBe(false);
    expect(GoalPatchSchema.safeParse({ masteryAccuracyPct: 101 }).success).toBe(false);
    expect(GoalPatchSchema.safeParse({ introducedAt: "2026-02-30" }).success).toBe(false);
    expect(GoalPatchSchema.safeParse({ settings: ["x".repeat(41)] }).success).toBe(false);
    expect(GoalPatchSchema.safeParse({ expectedUpdatedAt: "yesterday" }).success).toBe(false);
    expect(
      GoalPatchSchema.safeParse({ barriers: "", expectedUpdatedAt: "2026-10-30T12:00:00.000Z" }).success,
    ).toBe(true);
    expect(GoalPatchSchema.parse({ rationale: "Because." })).toEqual({ rationale: "Because." });
  });
});
