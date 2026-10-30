import { beforeAll, describe, expect, it } from "vitest";
import { db, withOrg } from "@/lib/db";
import { benefitsFindings } from "@/lib/payors/benefits";
import { loadClientData } from "@/lib/plan/context";
import { exportBlockers } from "@/lib/plan/presubmission";
import { createPlan, planView } from "@/lib/services/plans";
import {
  createClient,
  deleteClientPayor,
  saveAuthorization,
  saveBenefitsCheck,
  saveClientPayor,
} from "@/lib/services/records";
import { clientRequirements } from "@/lib/services/requirements";
import { AS_OF, dataset } from "../helpers/synthetic-eval";
import { clientId, ctxAs, org } from "../helpers/ctx";

const bcba = ctxAs("BCBA");
const coord = ctxAs("AUTH_COORDINATOR");
const other = dataset.orgs[1]!;
const otherBcba = { orgId: other.id, userId: other.users[0]!.id, role: "BCBA" as const };

const newClient = (lastName: string) => ({
  firstName: "Sky",
  lastName,
  dob: "2021-03-04",
  serviceAddress: { line1: "9 Fiction Rd", city: "Example City", state: "GA", zip: "30000" },
  fictional: true,
});
const check = (over: Record<string, unknown> = {}) => ({
  checkedOn: "2026-09-10",
  method: "phone",
  referenceNumber: "SYN-REF-7001",
  abaCovered: "yes",
  priorAuthRequired: "yes",
  planFunding: "unknown",
  ...over,
});

const payorId = (key: string) =>
  withOrg(bcba, (tx) => tx.payor.findFirstOrThrow({ where: { key } })).then((p) => p.id);

/** A fictional client with one primary insurance on the given payor. */
async function clientWith(key: string, planType: string | null, memberId: string) {
  const cid = (await createClient(bcba, newClient(`Benefits${memberId.slice(-3)}`))).id;
  const pid = await payorId(key);
  const ins = await saveClientPayor(bcba, cid, null, {
    payorId: pid,
    priority: "primary",
    memberId,
    planType,
  });
  return { cid, pid, insId: ins.id };
}

const planTypeOf = (id: string) =>
  withOrg(bcba, (tx) => tx.clientPayor.findUniqueOrThrow({ where: { id } })).then((r) => r.planType);

describe("benefits check validation", () => {
  let cid: string;
  let insId: string;
  beforeAll(async () => {
    ({ cid, insId } = await clientWith("cigna_evernorth", "commercial_unknown", "SYN-CIG-700001"));
  });

  it("accepts a complete check and stores blanks as not recorded", async () => {
    const r = await saveBenefitsCheck(
      coord,
      cid,
      insId,
      check({ referenceNumber: null, ageLimitYears: null, visitOrHourLimits: "", notes: "" }),
      AS_OF,
    );
    const row = await withOrg(bcba, (tx) => tx.benefitsCheck.findUniqueOrThrow({ where: { id: r.id } }));
    expect(row).toMatchObject({
      clientId: cid,
      clientPayorId: insId,
      checkedByUserId: coord.userId,
      method: "phone",
      referenceNumber: null,
      visitOrHourLimits: null,
      notes: null,
      ageLimitYears: null,
    });
  });

  it("rejects bad input", async () => {
    const bad = [
      check({ method: "fax" }),
      check({ abaCovered: "maybe" }),
      check({ planFunding: "aso" }),
      check({ checkedOn: "2026-02-30" }),
      // Identifiers are synthetic in v1.0, including call references.
      check({ referenceNumber: "REF123456" }),
      check({ ageLimitYears: 0 }),
      check({ ageLimitYears: 4.5 }),
      check({ visitOrHourLimits: "x".repeat(301) }),
      check({ notes: "x".repeat(1001) }),
    ];
    for (const b of bad) await expect(saveBenefitsCheck(bcba, cid, insId, b, AS_OF)).rejects.toThrow();
    await expect(
      saveBenefitsCheck(bcba, cid, insId, check({ checkedOn: "2026-10-30" }), AS_OF),
    ).rejects.toThrow(/future/);
    // Free text never carries identifiers; the insurance already holds the member ID.
    for (const t of [{ notes: "Member ID W123456789 confirmed" }, { visitOrHourLimits: "DOB 01/02/2020" }])
      await expect(saveBenefitsCheck(bcba, cid, insId, check(t), AS_OF)).rejects.toMatchObject({
        status: 422,
      });
    await expect(
      saveBenefitsCheck(bcba, cid, insId, check({ notes: "x".repeat(1000), ageLimitYears: 21 }), AS_OF),
    ).resolves.toHaveProperty("id");
  });

  it("only staff who manage insurance record checks, and only on the client's own insurance", async () => {
    for (const role of ["RBT", "PARENT"] as const)
      await expect(saveBenefitsCheck(ctxAs(role), cid, insId, check(), AS_OF)).rejects.toMatchObject({
        status: 403,
      });
    // Another client's insurance.
    const someoneElses = (
      await withOrg(bcba, (tx) =>
        tx.clientPayor.findFirstOrThrow({ where: { clientId: clientId("client1") } }),
      )
    ).id;
    await expect(saveBenefitsCheck(bcba, cid, someoneElses, check(), AS_OF)).rejects.toMatchObject({
      status: 404,
    });
  });

  it("audits every read and write of a check", async () => {
    const before = new Date();
    const r = await saveBenefitsCheck(bcba, cid, insId, check(), AS_OF);
    await clientRequirements(bcba, cid, AS_OF);
    const rows = await withOrg(bcba, (tx) =>
      tx.auditEvent.findMany({ where: { entityType: "BenefitsCheck", createdAt: { gte: before } } }),
    );
    const actions = rows.map((x) => x.action);
    expect(actions).toContain("benefits_check:create");
    expect(actions).toContain("write:create");
    expect(actions).toContain("read:findMany");
    expect(rows.find((x) => x.action === "benefits_check:create")!.entityId).toBe(r.id);
    // Meta holds ids and codes, never the notes or reference number.
    expect(JSON.stringify(rows.map((x) => x.meta))).not.toContain("SYN-REF");
  });

  it("checks are history: the app cannot edit one, and removing the insurance keeps it", async () => {
    const r = await saveBenefitsCheck(bcba, cid, insId, check(), AS_OF);
    await expect(
      withOrg(bcba, (tx) => tx.benefitsCheck.update({ where: { id: r.id }, data: { abaCovered: "no" } })),
    ).rejects.toThrow(/permission denied/i);
    await deleteClientPayor(bcba, cid, insId);
    const row = await withOrg(bcba, (tx) => tx.benefitsCheck.findUniqueOrThrow({ where: { id: r.id } }));
    expect(row.clientPayorId).toBeNull();
    expect(row.payorId).toBe(await payorId("cigna_evernorth"));
    expect((await clientRequirements(bcba, cid, AS_OF)).removedInsuranceChecks).toBeGreaterThan(0);
  });
});

describe("benefits check and the insurance's plan type", () => {
  it("confirms an unconfirmed commercial plan, audit-logged", async () => {
    const { cid, insId } = await clientWith("cigna_evernorth", "commercial_unknown", "SYN-CIG-700002");
    const r = await saveBenefitsCheck(bcba, cid, insId, check({ planFunding: "fully_insured" }), AS_OF);
    expect(r.planType).toEqual({ from: "commercial_unknown", to: "commercial_fully_insured" });
    expect(await planTypeOf(insId)).toBe("commercial_fully_insured");
    const ev = await withOrg(bcba, (tx) =>
      tx.auditEvent.findFirstOrThrow({
        where: { action: "insurance:plan_type_from_benefits_check", entityId: insId },
      }),
    );
    expect(ev.meta).toMatchObject({
      from: "commercial_unknown",
      to: "commercial_fully_insured",
      benefitsCheckId: r.id,
    });
    // Once confirmed, a later check never overwrites it.
    const again = await saveBenefitsCheck(bcba, cid, insId, check({ planFunding: "self_funded" }), AS_OF);
    expect(again.planType).toBeNull();
    expect(await planTypeOf(insId)).toBe("commercial_fully_insured");
  });

  it("sets a plan type not recorded on a commercial payor", async () => {
    const { cid, insId } = await clientWith("aetna", null, "SYN-AET-700003");
    expect(await planTypeOf(insId)).toBe("unknown");
    await saveBenefitsCheck(bcba, cid, insId, check({ planFunding: "self_funded" }), AS_OF);
    expect(await planTypeOf(insId)).toBe("commercial_self_funded");
  });

  it("leaves the plan type alone when the funding is not known", async () => {
    const { cid, insId } = await clientWith("aetna", "commercial_unknown", "SYN-AET-700004");
    expect((await saveBenefitsCheck(bcba, cid, insId, check(), AS_OF)).planType).toBeNull();
    expect(await planTypeOf(insId)).toBe("commercial_unknown");
  });

  it("never overwrites Medicaid or TRICARE, nor an unrecorded type on a non-commercial payor", async () => {
    for (const [key, planType, member] of [
      ["amerigroup", "medicaid_managed_care", "SYN-AMG-700005"],
      ["ga_medicaid", "medicaid", "SYN-GAM-700006"],
      ["tricare_east", "tricare", "SYN-TRI-700007"],
      ["tricare_east", null, "SYN-TRI-700008"],
      ["amerigroup", null, "SYN-AMG-700009"],
    ] as const) {
      const { cid, insId } = await clientWith(key, planType, member);
      const before = await planTypeOf(insId);
      for (const f of ["fully_insured", "self_funded"])
        expect(
          (await saveBenefitsCheck(bcba, cid, insId, check({ planFunding: f }), AS_OF)).planType,
        ).toBeNull();
      expect(await planTypeOf(insId)).toBe(before);
    }
  });
});

describe("benefits checks are isolated by org (RLS)", () => {
  it("another org sees none of them and cannot write one", async () => {
    const own = await withOrg(bcba, (tx) => tx.benefitsCheck.count());
    expect(own).toBeGreaterThan(0);
    const seen = await withOrg(
      otherBcba,
      (tx) => tx.$queryRaw<{ org_id: string }[]>`SELECT org_id::text FROM benefits_check`,
    );
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((r) => r.org_id === other.id)).toBe(true);
    expect(await db().$queryRaw<unknown[]>`SELECT * FROM benefits_check`).toEqual([]);

    // Through the service: the other org's insurance row is invisible, so it is a 404.
    const theirs = other.clients[0]!.payors[0]!.id;
    await expect(saveBenefitsCheck(bcba, other.clients[0]!.id, theirs, check(), AS_OF)).rejects.toMatchObject(
      { status: 404 },
    );
    // And a direct insert into the other org is refused by the policy.
    const c1 = org.clients.find((c) => c.key === "client1")!;
    const aetnaId = await payorId("aetna");
    await expect(
      withOrg(bcba, (tx) =>
        tx.benefitsCheck.create({
          data: {
            orgId: other.id,
            clientId: c1.id,
            payorId: aetnaId,
            checkedOn: new Date("2026-10-01"),
            checkedByUserId: bcba.userId,
            method: "phone",
          },
        }),
      ),
    ).rejects.toThrow(/row-level security/i);
    await expect(clientRequirements(otherBcba, c1.id, AS_OF)).rejects.toMatchObject({ status: 404 });
  });
});

describe("pre-submission audit: benefits check warnings", () => {
  it("warns (never blocks) until a check since the authorization start covers ABA and answers prior auth", async () => {
    const { cid, pid, insId } = await clientWith("cigna_evernorth", "commercial_unknown", "SYN-CIG-700010");
    await saveAuthorization(bcba, cid, null, {
      payorId: pid,
      authNumber: "SYN-AUTH-7010",
      kind: "initial",
      startDate: "2026-09-01",
      endDate: "2027-02-28",
      units: [{ cptCode: "97153", approvedUnits: 80, unitBasis: "week" }],
    });
    const planId = (await createPlan(bcba, cid, "initial")).id;
    const benefits = async () => {
      const { checks } = await planView(bcba, planId, AS_OF);
      const mine = checks.filter((c) => c.category === "Benefits check");
      expect(mine.every((c) => c.status === "warn")).toBe(true);
      expect(exportBlockers(mine)).toEqual([]);
      return mine.map((c) => c.id);
    };

    expect(await benefits()).toEqual(["benefits.not_checked"]);
    // Checked before the authorization started: still not current.
    await saveBenefitsCheck(bcba, cid, insId, check({ checkedOn: "2026-08-15" }), AS_OF);
    expect(await benefits()).toEqual(["benefits.not_checked"]);
    await saveBenefitsCheck(bcba, cid, insId, check({ checkedOn: "2026-09-10", abaCovered: "no" }), AS_OF);
    expect(await benefits()).toEqual(["benefits.not_covered"]);
    await saveBenefitsCheck(
      bcba,
      cid,
      insId,
      check({ checkedOn: "2026-09-11", priorAuthRequired: "unknown" }),
      AS_OF,
    );
    expect(await benefits()).toEqual(["benefits.prior_auth_unknown"]);
    await saveBenefitsCheck(bcba, cid, insId, check({ checkedOn: "2026-09-12" }), AS_OF);
    expect(await benefits()).toEqual([]);
  });

  it("the seeded clients have a current check, so no benefits warnings", async () => {
    for (const k of ["client1", "client2", "client3"] as const) {
      const b = await withOrg(bcba, (tx) => loadClientData(tx, clientId(k)));
      expect(b.benefitsChecks).toHaveLength(1);
      expect(
        benefitsFindings(b.benefitsChecks, {
          payorId: b.auth!.payorId,
          payorName: b.auth!.payor.name,
          startDate: b.auth!.startDate,
        }),
      ).toEqual([]);
    }
  });
});

describe("per-client payor requirements", () => {
  it("lists each insurance with its plan, the rules that apply, statuses, and check history", async () => {
    const d = await clientRequirements(bcba, clientId("client3"), AS_OF);
    expect(d.insurances.map((i) => [i.priority, i.payor.name, i.planType])).toEqual([
      ["primary", expect.stringMatching(/TRICARE/), "tricare"],
      ["secondary", expect.stringMatching(/^Aetna/), "commercial_self_funded"],
    ]);
    const [tri, aet] = d.insurances as [(typeof d.insurances)[0], (typeof d.insurances)[0]];
    expect(aet.planState).toBe("GA");
    expect(aet.planStateRecorded).toBe(true);
    // TRICARE is national: no plan state recorded, so the service state.
    expect(tri.planStateRecorded).toBe(false);
    expect(tri.planState).toBe("GA");
    for (const ins of d.insurances) {
      expect(ins.groups.length).toBeGreaterThan(0);
      const items = ins.groups.flatMap((g) => g.items);
      expect(items.every((r) => ["met", "missing", "manual", "n/a"].includes(r.status))).toBe(true);
      expect(items.every((r) => r.rule.payorKey === (ins === tri ? "tricare_east" : "aetna"))).toBe(true);
    }
    // Groups follow the topic order, each rule under its topic.
    const keys = tri.groups.map((g) => g.key);
    expect(keys.indexOf("submitting")).toBeLessThan(keys.indexOf("documents"));
    expect(
      tri.groups
        .find((g) => g.key === "staff")!
        .items.every((r) => r.rule.type === "staff_credential" || r.rule.type === "supervision_ratio"),
    ).toBe(true);
    // The seeded benefits check is on the primary only.
    expect(tri.checks).toHaveLength(1);
    expect(tri.checks[0]).toMatchObject({
      method: "phone",
      abaCovered: "yes",
      checkedBy: expect.any(String),
    });
    expect(aet.checks).toEqual([]);
  });

  it("hides rules limited to other plan types, and evaluates the secondary on its own plan type", async () => {
    const rule = await withOrg(bcba, (tx) =>
      tx.payorRule.findFirstOrThrow({ where: { payor: { key: "aetna" } }, orderBy: { ordinal: "asc" } }),
    );
    try {
      await withOrg(bcba, (tx) =>
        tx.payorRule.update({ where: { id: rule.id }, data: { planTypes: ["commercial_fully_insured"] } }),
      );
      const d = await clientRequirements(bcba, clientId("client3"), AS_OF);
      const aet = d.insurances.find((i) => i.priority === "secondary")!;
      expect(aet.otherPlanTypeRules).toBe(1);
      expect(aet.groups.flatMap((g) => g.items).some((r) => r.rule.id === rule.id)).toBe(false);
    } finally {
      await withOrg(bcba, (tx) => tx.payorRule.update({ where: { id: rule.id }, data: { planTypes: [] } }));
    }
  });

  it("lists requirements from confirmed letters with the letter date", async () => {
    // A fresh client: other test files upload letters for the seeded ones.
    const { cid } = await clientWith("cigna_evernorth", "commercial_fully_insured", "SYN-CIG-700011");
    const [confirmed, pending] = await withOrg(bcba, async (tx) => [
      await tx.payorLetter.create({
        data: {
          orgId: org.id,
          clientId: cid,
          filename: "synthetic-approval.txt",
          text: "Synthetic letter",
          classification: "approval",
          status: "confirmed",
          createdAt: new Date("2026-09-20T15:00:00Z"),
          extracted: { requirements: ["Send updated progress graphs with the next request"] },
        },
      }),
      await tx.payorLetter.create({
        data: {
          orgId: org.id,
          clientId: cid,
          filename: "synthetic-pending.txt",
          text: "Synthetic letter",
          extracted: { requirements: ["Not confirmed yet"] },
        },
      }),
    ]);
    try {
      const d = await clientRequirements(bcba, cid, AS_OF);
      expect(d.letters).toEqual([
        {
          id: confirmed.id,
          date: "2026-09-20",
          classification: "approval",
          requirements: ["Send updated progress graphs with the next request"],
        },
      ]);
      expect(d.unconfirmedLetters).toBe(1);
    } finally {
      await withOrg(bcba, (tx) =>
        tx.payorLetter.deleteMany({ where: { id: { in: [confirmed.id, pending.id] } } }),
      );
    }
  });

  it("follows the plan and packet viewing permission", async () => {
    await expect(clientRequirements(ctxAs("RBT"), clientId("client1"), AS_OF)).resolves.toHaveProperty(
      "insurances",
    );
    await expect(clientRequirements(ctxAs("PARENT"), clientId("client1"), AS_OF)).rejects.toMatchObject({
      status: 403,
    });
  });
});
