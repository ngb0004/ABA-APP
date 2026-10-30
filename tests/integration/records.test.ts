import { beforeAll, describe, expect, it } from "vitest";
import { withOrg } from "@/lib/db";
import {
  addDataPoint,
  addMember,
  addSession,
  changeMemberRole,
  createClient,
  deleteAuthorization,
  deleteDataPoint,
  deleteDiagnosis,
  practiceSettings,
  removeMember,
  saveAttachment,
  saveAuthorization,
  saveClientPayor,
  saveDiagnosis,
  updateClient,
  updateSettings,
} from "@/lib/services/records";
import { clientDetail } from "@/lib/services/clients";
import { evaluateClientRules } from "@/lib/services/payors";
import { AS_OF, dataset } from "../helpers/synthetic-eval";
import { clientId, ctxAs, org } from "../helpers/ctx";

const bcba = ctxAs("BCBA");
const other = dataset.orgs[1]!;
const otherBcba = { orgId: other.id, userId: other.users[0]!.id, role: "BCBA" as const };

const newClient = {
  firstName: "Robin",
  lastName: "Testcase",
  dob: "2021-04-02",
  serviceAddress: { line1: "1 Fiction Ln", city: "Example City", state: "GA", zip: "30000" },
  guardians: [{ name: "Pat Testcase", relationship: "mother", legalCustody: true, canSign: true }],
  fictional: true,
};

let cid: string;
let cignaId: string;

beforeAll(async () => {
  cid = (await createClient(bcba, newClient)).id;
  cignaId = (await withOrg(bcba, (tx) => tx.payor.findFirstOrThrow({ where: { key: "cigna_evernorth" } })))
    .id;
});

describe("clients", () => {
  it("creates only synthetic clients, and only with the fictional confirmation", async () => {
    await expect(createClient(bcba, { ...newClient, fictional: false })).rejects.toThrow(/fictional/);
    await expect(createClient(ctxAs("RBT"), newClient)).rejects.toMatchObject({ status: 403 });
    await expect(createClient(bcba, { ...newClient, dob: "2021-02-30" })).rejects.toThrow();
    const c = await withOrg(bcba, (tx) => tx.client.findUniqueOrThrow({ where: { id: cid } }));
    expect(c.isSynthetic).toBe(true);
    const audit = await withOrg(bcba, (tx) =>
      tx.auditEvent.count({ where: { action: "client:create", entityId: cid } }),
    );
    expect(audit).toBe(1);
  });

  it("updates details; another practice cannot see or change them", async () => {
    await updateClient(bcba, cid, { preferredName: "Robbie", hasIep: true });
    const d = await clientDetail(bcba, cid, AS_OF);
    expect(d.client).toMatchObject({ preferredName: "Robbie", hasIep: true });
    await expect(updateClient(otherBcba, cid, { hasIep: false })).rejects.toMatchObject({ status: 404 });
  });
});

describe("insurance, diagnoses, authorizations", () => {
  it("member IDs must be synthetic; one primary payor at a time", async () => {
    const payor = { payorId: cignaId, priority: "primary", memberId: "SYN-CIG-777777" };
    await expect(saveClientPayor(bcba, cid, null, { ...payor, memberId: "W123456789" })).rejects.toThrow(
      /SYN-/,
    );
    await saveClientPayor(bcba, cid, null, payor);
    await expect(
      saveClientPayor(bcba, cid, null, { ...payor, memberId: "SYN-CIG-888888" }),
    ).rejects.toMatchObject({ status: 409 });
    // The auth coordinator manages insurance too; an RBT does not.
    await saveClientPayor(ctxAs("AUTH_COORDINATOR"), cid, null, {
      ...payor,
      priority: "secondary",
      memberId: "SYN-CIG-999999",
    });
    await expect(
      saveClientPayor(ctxAs("RBT"), cid, null, { ...payor, priority: "secondary" }),
    ).rejects.toMatchObject({ status: 403 });
  });

  it("keeps one primary diagnosis and never strands a linked goal", async () => {
    const dx = {
      dsm5Code: "299.00",
      dsm5Label: "Autism spectrum disorder",
      icd10Code: "F84.0",
      isPrimary: true,
      evaluationDate: "2026-01-15",
      deficitAreas: ["communication", "social_interaction"],
    };
    const a = await saveDiagnosis(bcba, cid, null, dx);
    const b = await saveDiagnosis(bcba, cid, null, {
      ...dx,
      icd10Code: "F80.2",
      deficitAreas: ["communication"],
    });
    const rows = await withOrg(bcba, (tx) => tx.diagnosis.findMany({ where: { clientId: cid } }));
    expect(rows.filter((r) => r.isPrimary).map((r) => r.id)).toEqual([b.id]);
    await expect(saveDiagnosis(bcba, cid, null, { ...dx, icd10Code: "autism" })).rejects.toThrow();
    // A goal linked through "social_interaction" keeps that area from being removed.
    const g = await withOrg(bcba, (tx) =>
      tx.goal.create({
        data: {
          orgId: bcba.orgId,
          clientId: cid,
          diagnosisId: a.id,
          deficitArea: "social_interaction",
          ordinal: 1,
          domain: "Social",
          tier: 1,
          category: "social_play",
          objective: "Test",
        },
      }),
    );
    await expect(
      saveDiagnosis(bcba, cid, a.id, { ...dx, deficitAreas: ["communication"] }),
    ).rejects.toMatchObject({ status: 409 });
    await expect(deleteDiagnosis(bcba, cid, a.id)).rejects.toMatchObject({ status: 409 });
    await withOrg(bcba, (tx) => tx.goal.delete({ where: { id: g.id } }));
    await deleteDiagnosis(bcba, cid, b.id);
  });

  it("authorizations: synthetic numbers, sane dates, units as a set, rules evaluate against them", async () => {
    const auth = {
      payorId: cignaId,
      authNumber: "SYN-AUTH-7777",
      kind: "initial",
      startDate: "2026-09-01",
      endDate: "2027-02-28",
      units: [
        { cptCode: "97153", approvedUnits: 80, unitBasis: "week" },
        { cptCode: "97155", approvedUnits: 8, unitBasis: "week" },
      ],
    };
    await expect(saveAuthorization(bcba, cid, null, { ...auth, endDate: "2026-08-01" })).rejects.toThrow(
      /after/,
    );
    await expect(
      saveAuthorization(bcba, cid, null, { ...auth, units: [...auth.units, auth.units[0]] }),
    ).rejects.toThrow(/once/);
    const { id } = await saveAuthorization(bcba, cid, null, auth);
    await saveAuthorization(bcba, cid, id, {
      ...auth,
      units: [{ cptCode: "97153", approvedUnits: 60, unitBasis: "week" }],
    });
    const units = await withOrg(bcba, (tx) =>
      tx.authorizationUnit.findMany({ where: { authorizationId: id } }),
    );
    expect(units.map((u) => [u.cptCode, u.approvedUnits])).toEqual([["97153", 60]]);
    const { results } = await withOrg(bcba, (tx) => evaluateClientRules(tx, cid, AS_OF));
    expect(results.length).toBeGreaterThan(0);

    // Sessions must fall inside the authorization; then the authorization cannot be deleted.
    const session = {
      authorizationId: id,
      cptCode: "97153",
      date: "2026-09-02",
      startMinute: 540,
      units: 8,
      providerRole: "RBT",
      providerId: "RBT-Z",
    };
    await expect(addSession(bcba, cid, { ...session, date: "2026-08-02" })).rejects.toThrow(/outside/);
    await expect(addSession(bcba, cid, { ...session, providerId: "Jane Smith" })).rejects.toThrow(/no names/);
    await addSession(ctxAs("RBT"), cid, session);
    await expect(deleteAuthorization(bcba, cid, id)).rejects.toMatchObject({ status: 409 });
    await expect(
      saveAuthorization(bcba, cid, id, { ...auth, startDate: "2026-10-01" }),
    ).rejects.toMatchObject({ status: 409 });
  });

  it("attachments record metadata only", async () => {
    const a = await saveAttachment(ctxAs("AUTH_COORDINATOR"), cid, null, {
      kind: "diagnostic_evaluation",
      title: "Diagnostic evaluation",
      documentDate: "2026-01-15",
    });
    const row = await withOrg(bcba, (tx) => tx.attachment.findUniqueOrThrow({ where: { id: a.id } }));
    expect(row).toMatchObject({ kind: "diagnostic_evaluation", caregiverSigned: false });
    await expect(
      saveAttachment(ctxAs("RBT"), cid, null, { kind: "other", title: "x" }),
    ).rejects.toMatchObject({ status: 403 });
  });
});

describe("goal data", () => {
  it("RBTs enter data points; percent values stay in range; locked baseline points stay", async () => {
    const goal = await withOrg(bcba, (tx) =>
      tx.goal.findFirstOrThrow({ where: { clientId: clientId("client1"), baselineLockedAt: { not: null } } }),
    );
    const p = await addDataPoint(ctxAs("RBT"), goal.id, { date: "2026-10-20", value: 55, trials: 10 });
    if (goal.measure === "percent")
      await expect(
        addDataPoint(ctxAs("RBT"), goal.id, { date: "2026-10-21", value: 120 }),
      ).rejects.toMatchObject({
        status: 422,
      });
    await deleteDataPoint(ctxAs("RBT"), goal.id, p.id);
    const first = await withOrg(bcba, (tx) =>
      tx.goalDataPoint.findFirstOrThrow({ where: { goalId: goal.id }, orderBy: { date: "asc" } }),
    );
    await expect(deleteDataPoint(bcba, goal.id, first.id)).rejects.toMatchObject({ status: 409 });
  });
});

describe("practice settings and team", () => {
  it("BCBA edits settings without losing keys the form does not show", async () => {
    await expect(practiceSettings(ctxAs("RBT"))).rejects.toMatchObject({ status: 403 });
    const before = (await practiceSettings(bcba)).org;
    await updateSettings(bcba, {
      name: before.name,
      npi: "SYN-NPI-1111111111",
      taxId: null,
      offices: [{ state: "GA", address: "100 Example Way, Peachtree City, GA 30269" }],
      reauthLeadDays: 35,
      reassessmentLeadDays: 45,
    });
    const after = (await practiceSettings(bcba)).org.settings as Record<string, unknown>;
    expect(after).toMatchObject({ npi: "SYN-NPI-1111111111", reauthLeadDays: 35 });
    expect(after.seededAsOf).toBe((before.settings as Record<string, unknown>).seededAsOf);
  });

  it("adds, re-roles, and removes members; always keeps a BCBA", async () => {
    const m = await addMember(bcba, {
      email: "new.rbt@sample-practice.test",
      name: "New RBT",
      role: "RBT",
      password: "a-long-temporary-pass",
    });
    await expect(
      addMember(bcba, {
        email: "new.rbt@sample-practice.test",
        name: "x",
        role: "RBT",
        password: "a-long-temporary-pass",
      }),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      addMember(bcba, { email: "short@sample-practice.test", name: "x", role: "RBT", password: "short" }),
    ).rejects.toThrow(/12/);
    await changeMemberRole(bcba, m.id, "BCaBA");
    const team = (await practiceSettings(bcba)).members;
    expect(team.find((x) => x.id === m.id)).toMatchObject({ role: "BCaBA", mfaEnabled: false });
    const mine = team.find((x) => x.userId === bcba.userId)!;
    await expect(removeMember(bcba, mine.id)).rejects.toMatchObject({ status: 409 });
    // The only BCBA cannot be demoted.
    const bcbas = team.filter((x) => x.role === "BCBA");
    if (bcbas.length === 1)
      await expect(changeMemberRole(bcba, mine.id, "RBT")).rejects.toMatchObject({ status: 409 });
    await removeMember(bcba, m.id);
    expect((await practiceSettings(bcba)).members.some((x) => x.id === m.id)).toBe(false);
    // Another practice's members are invisible.
    await expect(removeMember(otherBcba, mine.id)).rejects.toMatchObject({ status: 404 });
    void org;
  });
});

describe("review fixes", () => {
  it("a partial client update leaves guardians, IEP, and events alone", async () => {
    const before = await withOrg(bcba, (tx) => tx.client.findUniqueOrThrow({ where: { id: cid } }));
    await updateClient(bcba, cid, { preferredName: "Robs" });
    const after = await withOrg(bcba, (tx) => tx.client.findUniqueOrThrow({ where: { id: cid } }));
    expect(after.guardians).toEqual(before.guardians);
    expect(after.hasIep).toBe(before.hasIep);
  });

  it("on the demo site the client's identity is generated and cannot be typed", async () => {
    process.env.DEMO_MODE = "true";
    try {
      const { id } = await createClient(bcba, { ...newClient, ageYears: 6 }, "2026-10-29");
      const c = await withOrg(bcba, (tx) => tx.client.findUniqueOrThrow({ where: { id } }));
      expect(c.firstName).not.toBe("Robin");
      expect(c.lastName).toMatch(/^Testchild/);
      expect(c.dob.toISOString().slice(0, 4)).toBe("2020");
      await expect(updateClient(bcba, id, { firstName: "Real" })).rejects.toMatchObject({ status: 403 });
      await updateClient(bcba, id, { hasIep: true });
    } finally {
      delete process.env.DEMO_MODE;
    }
  });

  it("removed members can be re-added, and lose access at once", async () => {
    const add = () =>
      addMember(bcba, {
        email: "again@sample-practice.test",
        name: "Again",
        role: "RBT",
        password: "another-long-pass",
      });
    const m = await add();
    await removeMember(bcba, m.id);
    const again = await add();
    expect(again.id).not.toBe(m.id);
    await removeMember(bcba, again.id);
  });

  it("sessions need an approved code; locked-baseline dates are protected", async () => {
    const auth = await withOrg(bcba, (tx) =>
      tx.authorization.findFirstOrThrow({ where: { clientId: cid }, include: { units: true } }),
    );
    await expect(
      addSession(bcba, cid, {
        authorizationId: auth.id,
        cptCode: "97158",
        date: "2026-09-03",
        startMinute: 540,
        units: 4,
        providerRole: "BCBA",
        providerId: "BCBA-1",
      }),
    ).rejects.toThrow(/does not approve/);
    const goal = await withOrg(bcba, (tx) =>
      tx.goal.findFirstOrThrow({ where: { clientId: clientId("client1"), baselineLockedAt: { not: null } } }),
    );
    await expect(
      addDataPoint(ctxAs("RBT"), goal.id, { date: goal.baselineDate!.toISOString().slice(0, 10), value: 10 }),
    ).rejects.toThrow(/locked/);
  });

  it("insurance always has a primary; diagnoses always have exactly one primary", async () => {
    const c2 = (await createClient(bcba, { ...newClient, firstName: "Sam" })).id;
    await expect(
      saveClientPayor(bcba, c2, null, {
        payorId: cignaId,
        priority: "secondary",
        memberId: "SYN-CIG-123123",
      }),
    ).rejects.toMatchObject({ status: 422 });
    const dx = {
      dsm5Code: "299.00",
      dsm5Label: "Autism spectrum disorder",
      icd10Code: "F84.0",
      isPrimary: false,
      deficitAreas: ["communication"],
    };
    const a = await saveDiagnosis(bcba, c2, null, dx); // first one becomes primary anyway
    const b = await saveDiagnosis(bcba, c2, null, { ...dx, icd10Code: "F80.2" });
    await expect(saveDiagnosis(bcba, c2, a.id, dx)).rejects.toMatchObject({ status: 409 });
    await deleteDiagnosis(bcba, c2, a.id);
    const rows = await withOrg(bcba, (tx) => tx.diagnosis.findMany({ where: { clientId: c2 } }));
    expect(rows).toEqual([expect.objectContaining({ id: b.id, isPrimary: true })]);
  });
});

describe("QA fixes: dates, authorizations, provider roles", () => {
  const dx = {
    dsm5Code: "299.00",
    dsm5Label: "Autism spectrum disorder",
    icd10Code: "F84.0",
    isPrimary: true,
    deficitAreas: ["communication"],
  };

  it("rejects evaluation and document dates after today", async () => {
    await expect(
      saveDiagnosis(bcba, cid, null, { ...dx, evaluationDate: "2030-01-01" }, AS_OF),
    ).rejects.toMatchObject({ status: 422, message: expect.stringMatching(/future/) });
    await expect(
      saveAttachment(
        bcba,
        cid,
        null,
        { kind: "diagnostic_evaluation", title: "Evaluation", documentDate: "2026-10-30" },
        AS_OF,
      ),
    ).rejects.toMatchObject({ status: 422 });
    // Today itself is fine.
    const a = await saveAttachment(
      bcba,
      cid,
      null,
      { kind: "other", title: "Same-day note", documentDate: AS_OF },
      AS_OF,
    );
    expect(a.id).toBeTruthy();
  });

  it("authorizations need at least one code and a payor the client has insurance with", async () => {
    const auth = {
      payorId: cignaId,
      authNumber: "SYN-AUTH-QA01",
      kind: "initial",
      startDate: "2026-09-01",
      endDate: "2027-02-28",
      units: [{ cptCode: "97153", approvedUnits: 40, unitBasis: "week" }],
    };
    await expect(saveAuthorization(bcba, cid, null, { ...auth, units: [] })).rejects.toThrow(
      /at least one approved CPT code/,
    );
    const otherPayor = await withOrg(bcba, (tx) =>
      tx.payor.findFirstOrThrow({ where: { key: { not: "cigna_evernorth" } } }),
    );
    await expect(
      saveAuthorization(bcba, cid, null, { ...auth, payorId: otherPayor.id }),
    ).rejects.toMatchObject({ status: 422, message: expect.stringMatching(/no insurance with that payor/) });
  });

  it("sessions: no future dates, the role must be able to deliver the code, staff code matches the role", async () => {
    const { id: authorizationId } = await saveAuthorization(bcba, cid, null, {
      payorId: cignaId,
      authNumber: "SYN-AUTH-QA02",
      kind: "initial",
      startDate: "2026-09-01",
      endDate: "2027-02-28",
      units: [
        { cptCode: "97153", approvedUnits: 40, unitBasis: "week" },
        { cptCode: "97156", approvedUnits: 12, unitBasis: "auth" },
      ],
    });
    const s = {
      authorizationId,
      cptCode: "97153",
      date: "2026-10-01",
      startMinute: 540,
      units: 4,
      providerRole: "RBT",
      providerId: "RBT-Q",
    };
    await expect(addSession(bcba, cid, { ...s, date: "2026-11-15" }, AS_OF)).rejects.toThrow(/future/);
    await expect(addSession(bcba, cid, { ...s, cptCode: "97156" }, AS_OF)).rejects.toThrow(/BCBA or BCaBA/);
    await expect(addSession(bcba, cid, { ...s, providerId: "BCBA-Q" }, AS_OF)).rejects.toThrow(
      /looks like a BCBA code/,
    );
    await expect(
      addSession(bcba, cid, { ...s, cptCode: "97156", providerRole: "BCaBA", providerId: "BCBA-Q" }, AS_OF),
    ).rejects.toMatchObject({ status: 422 });
    // Lenient: BCBAs may deliver 97153, and codes without a role prefix are accepted.
    await addSession(bcba, cid, { ...s, providerRole: "BCBA", providerId: "BCBA-Q" }, AS_OF);
    await addSession(bcba, cid, { ...s, cptCode: "97156", providerRole: "BCaBA", providerId: "S-12" }, AS_OF);
    await addSession(bcba, cid, s, AS_OF);
  });

  it("rejects goal data points after today", async () => {
    const goal = await withOrg(bcba, (tx) =>
      tx.goal.findFirstOrThrow({ where: { clientId: clientId("client1"), baselineLockedAt: { not: null } } }),
    );
    await expect(
      addDataPoint(ctxAs("RBT"), goal.id, { date: "2027-05-01", value: 40 }, AS_OF),
    ).rejects.toMatchObject({ status: 422, message: expect.stringMatching(/future/) });
  });
});
