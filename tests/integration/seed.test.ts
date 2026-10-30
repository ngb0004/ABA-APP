import { describe, expect, it } from "vitest";
import { withOrg } from "@/lib/db";
import { seedAll } from "../../seed/synthetic/index";
import { dataset } from "../helpers/synthetic-eval";

const TABLES = [
  "client",
  "diagnosis",
  "client_payor",
  "attachment",
  "authorization",
  "authorization_unit",
  "service_session",
  "intake",
  "vbmapp_administration",
  "milestone_score",
  "payor",
  "payor_rule",
  "goal_template",
  "goal",
  "goal_data_point",
  "membership",
];

async function counts(orgId: string) {
  return withOrg({ orgId, userId: null, role: null }, async (tx) => {
    const out: Record<string, number> = {};
    for (const t of TABLES)
      out[t] = Number(
        (await tx.$queryRawUnsafe<{ n: bigint }[]>(`SELECT count(*)::bigint AS n FROM "${t}"`))[0]!.n,
      );
    return out;
  });
}

describe("synthetic seed", () => {
  it("is idempotent", async () => {
    // Seed twice: earlier tests may have changed the data, so compare seed-to-seed.
    await seedAll(dataset.asOf);
    const before = await Promise.all(dataset.orgs.map((o) => counts(o.id)));
    await seedAll(dataset.asOf);
    const after = await Promise.all(dataset.orgs.map((o) => counts(o.id)));
    expect(after).toEqual(before);
    expect(before[0]!.client).toBe(3);
    expect(before[0]!.goal_template).toBe(54);
    expect(before[0]!.vbmapp_administration).toBe(4); // Client 2 has two
  });

  it("marks every client synthetic with SYN- member IDs and fictional names", async () => {
    for (const o of dataset.orgs) {
      const rows = await withOrg({ orgId: o.id, userId: null, role: null }, (tx) =>
        tx.client.findMany({ include: { payors: true } }),
      );
      for (const c of rows) {
        expect(c.isSynthetic).toBe(true);
        expect(c.lastName).toMatch(/^(Testchild|Otherorg)$/);
        for (const p of c.payors) expect(p.memberId).toMatch(/^SYN-/);
      }
    }
  });

  it("records plan types on insurance and syncs payor states from the YAML", async () => {
    const ctx = { orgId: dataset.orgs[0]!.id, userId: null, role: null };
    const rows = await withOrg(ctx, (tx) => tx.clientPayor.findMany({ include: { payor: true } }));
    const byPayor = Object.fromEntries(rows.map((r) => [r.payor.key, r]));
    expect(byPayor.amerigroup).toMatchObject({ planType: "medicaid_managed_care", planState: "GA" });
    expect(byPayor.cigna_evernorth).toMatchObject({ planType: "commercial_fully_insured" });
    expect(byPayor.tricare_east).toMatchObject({ planType: "tricare", planState: null });
    expect(byPayor.amerigroup!.payor).toMatchObject({
      states: ["GA"],
      lineOfBusiness: "medicaid_managed_care",
    });
    expect(byPayor.tricare_east!.payor).toMatchObject({ states: [], lineOfBusiness: "tricare" });
  });

  it("gives each client 26 weeks of goal data and Client 3 a caregiver-training shortfall", () => {
    const [c1, c2, c3] = dataset.orgs[0]!.clients;
    for (const c of [c1!, c2!, c3!])
      for (const g of c.goals) {
        const first = g.dataPoints[0]!.date;
        const last = g.dataPoints.at(-1)!.date;
        expect((Date.parse(last) - Date.parse(first)) / 86400000).toBeGreaterThan(24 * 7);
      }
    expect(c3!.sessions.filter((s) => s.cptCode === "97156")).toHaveLength(3);
  });
});
