import { readFileSync } from "node:fs";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { MockProvider, setLlmProvider } from "@/lib/ai";
import type { LlmRequest } from "@/lib/ai/provider";
import { ZodError } from "zod";
import { CLIENT_INACTIVE_MESSAGE } from "@/lib/client-status";
import { withOrg } from "@/lib/db";
import { addDays } from "@/lib/dates";
import { ForbiddenError } from "@/lib/log";
import { createAssessment } from "@/lib/services/assessments";
import { uploadAssessmentImport } from "@/lib/services/assessment-imports";
import { caseload, clientDetail, listClients } from "@/lib/services/clients";
import { assertClientActive, clientStatusSummary, setClientStatus } from "@/lib/services/client-status";
import { uploadLetter } from "@/lib/services/letters";
import { goalsView } from "@/lib/services/goals";
import { addGoalFromTemplate, listAudit } from "@/lib/services/misc";
import { exportPacketPdf, packetView, setChecklistDone } from "@/lib/services/packets";
import {
  approveGoal,
  approveSection,
  createPlan,
  discontinueGoal,
  draftSection,
  editSection,
  planView,
  updateGoal,
} from "@/lib/services/plans";
import {
  addDataPoint,
  addSession,
  createClient,
  deleteSession,
  saveAuthorization,
  saveClientPayor,
} from "@/lib/services/records";
import { clientRequirements } from "@/lib/services/requirements";
import { confirmImport, uploadVbmapp } from "@/lib/services/vbmapp";
import { AS_OF, dataset } from "../helpers/synthetic-eval";
import { ctxAs, org } from "../helpers/ctx";

const bcba = ctxAs("BCBA");
const other = dataset.orgs[1]!;
const otherBcba = { orgId: other.id, userId: other.users[0]!.id, role: "BCBA" as const };
const golf = org.clients.find((c) => c.key === "client4")!;

const fictional = (lastName: string) => ({
  firstName: "Robin",
  lastName,
  dob: "2022-03-02",
  serviceAddress: { line1: "9 Fiction Ln", city: "Example City", state: "GA", zip: "30000" },
  guardians: [{ name: "Pat Testcase", relationship: "mother", legalCustody: true, canSign: true }],
  fictional: true,
});

let payorId: string;
let templateId: string;

beforeAll(async () => {
  ({ payorId, templateId } = await withOrg(bcba, async (tx) => ({
    payorId: (await tx.payor.findFirstOrThrow({ where: { key: "aetna" } })).id,
    templateId: (
      await tx.goalTemplate.findFirstOrThrow({ orderBy: [{ domainNumber: "asc" }, { tier: "asc" }] })
    ).id,
  })));
});

/** A fictional client whose authorization ends in 20 days: it has alerts and due dates while active. */
async function clientEndingSoon(lastName: string) {
  const cid = (await createClient(bcba, fictional(lastName), AS_OF)).id;
  await saveClientPayor(bcba, cid, null, {
    payorId,
    priority: "primary",
    memberId: `SYN-AET-${lastName.toUpperCase()}`,
    planType: "commercial_fully_insured",
  });
  const auth = await saveAuthorization(bcba, cid, null, {
    payorId,
    authNumber: `SYN-AUTH-${lastName.toUpperCase()}`,
    kind: "initial",
    startDate: addDays(AS_OF, -60),
    endDate: addDays(AS_OF, 20),
    recommendedHoursPerWeek: 10,
    units: [
      { cptCode: "97151", approvedUnits: 24, unitBasis: "auth" },
      { cptCode: "97153", approvedUnits: 40, unitBasis: "week" },
    ],
  });
  return { cid, authorizationId: (auth as { id: string }).id };
}

const inactivate = (cid: string, over: Record<string, unknown> = {}) =>
  setClientStatus(bcba, cid, { status: "inactive", date: AS_OF, reason: "transferred", ...over }, AS_OF);
const reactivate = (cid: string) => setClientStatus(bcba, cid, { status: "active" }, AS_OF);
const auditRows = (action: string, entityId: string) =>
  withOrg(bcba, (tx) =>
    tx.auditEvent.findMany({ where: { action, entityId }, orderBy: { createdAt: "asc" } }),
  );
const blocked = { status: 409, message: CLIENT_INACTIVE_MESSAGE };

afterEach(() => setLlmProvider(null));

describe("marking a client inactive or active again", () => {
  it("validates the date, reason, and note", async () => {
    const { cid } = await clientEndingSoon("Statusvalid");
    await expect(
      setClientStatus(bcba, cid, { status: "inactive", date: AS_OF }, AS_OF),
    ).rejects.toBeInstanceOf(ZodError);
    await expect(inactivate(cid, { reason: "moved_away" })).rejects.toBeInstanceOf(ZodError);
    await expect(inactivate(cid, { date: "2026-02-30" })).rejects.toBeInstanceOf(ZodError);
    await expect(inactivate(cid, { date: addDays(AS_OF, 2) })).rejects.toMatchObject({ status: 422 });
    // Before the client's first authorization or session.
    await expect(inactivate(cid, { date: addDays(AS_OF, -61) })).rejects.toMatchObject({ status: 422 });
    await expect(inactivate(cid, { note: "x".repeat(501) })).rejects.toBeInstanceOf(ZodError);
    for (const note of ["Member ID SYN-AET-000401 ended", "DOB 2022-03-02", "my client Jamie Doe moved"])
      await expect(inactivate(cid, { note })).rejects.toMatchObject({ status: 422 });
    expect((await clientStatusSummary(bcba, cid)).status).toBe("active");
    // A client with no authorization or session is still bounded by the date of birth.
    const bare = (await createClient(bcba, fictional("Statusbare"), AS_OF)).id;
    await expect(inactivate(bare, { date: "1900-01-01" })).rejects.toMatchObject({ status: 422 });
    await expect(inactivate(bare, { date: "2022-03-01" })).rejects.toMatchObject({ status: 422 });
    await expect(inactivate(bare, { date: "2022-03-02" })).resolves.toEqual({ status: "inactive" });
    // One day of tolerance for time zones, like other record dates.
    await expect(inactivate(cid, { date: addDays(AS_OF, 1) })).resolves.toEqual({ status: "inactive" });
  });

  it("only a BCBA may change the status", async () => {
    const { cid } = await clientEndingSoon("Statusperm");
    const bcaba = { orgId: org.id, userId: null, role: "BCaBA" as const };
    for (const ctx of [ctxAs("RBT"), ctxAs("PARENT"), ctxAs("AUTH_COORDINATOR"), bcaba]) {
      await expect(
        setClientStatus(ctx, cid, { status: "inactive", date: AS_OF, reason: "other" }, AS_OF),
      ).rejects.toBeInstanceOf(ForbiddenError);
      await expect(setClientStatus(ctx, cid, { status: "active" }, AS_OF)).rejects.toBeInstanceOf(
        ForbiddenError,
      );
    }
  });

  it("records the reason code and date in the audit log (never the note), and reactivation clears the fields", async () => {
    const { cid } = await clientEndingSoon("Statusaudit");
    const note = "Family chose a clinic closer to home";
    await inactivate(cid, { reason: "family_withdrew", note, date: addDays(AS_OF, -3) });
    const c = await clientStatusSummary(bcba, cid);
    expect(c).toMatchObject({ status: "inactive", inactiveReason: "family_withdrew", inactiveNote: note });
    expect(c.inactiveSince!.toISOString().slice(0, 10)).toBe(addDays(AS_OF, -3));
    await expect(inactivate(cid)).rejects.toMatchObject({ status: 409 });

    const [ev] = await auditRows("client:inactivate", cid);
    expect(ev).toMatchObject({
      entityType: "Client",
      userId: bcba.userId,
      meta: { reason: "family_withdrew", inactiveSince: addDays(AS_OF, -3), hasNote: true },
    });

    await expect(reactivate(cid)).resolves.toEqual({ status: "active" });
    expect(await clientStatusSummary(bcba, cid)).toMatchObject({
      status: "active",
      inactiveSince: null,
      inactiveReason: null,
      inactiveNote: null,
    });
    await expect(reactivate(cid)).rejects.toMatchObject({ status: 409 });
    const [re] = await auditRows("client:reactivate", cid);
    expect(re!.meta).toMatchObject({ previousReason: "family_withdrew", inactiveSince: addDays(AS_OF, -3) });
    const all = await withOrg(bcba, (tx) => tx.auditEvent.findMany({ where: { entityId: cid } }));
    expect(JSON.stringify(all.map((a) => a.meta))).not.toContain("closer to home");
  });

  it("concurrent status changes apply once, with one audit row", async () => {
    const { cid } = await clientEndingSoon("Statusrace");
    const tries = await Promise.allSettled([
      inactivate(cid, { reason: "transferred" }),
      inactivate(cid, { reason: "other", date: addDays(AS_OF, -1) }),
    ]);
    expect(tries.filter((t) => t.status === "fulfilled")).toHaveLength(1);
    expect(tries.find((t) => t.status === "rejected")).toMatchObject({ reason: { status: 409 } });
    expect(await auditRows("client:inactivate", cid)).toHaveLength(1);
    const back = await Promise.allSettled([reactivate(cid), reactivate(cid)]);
    expect(back.filter((t) => t.status === "fulfilled")).toHaveLength(1);
    expect(await auditRows("client:reactivate", cid)).toHaveLength(1);
  });

  it("an inactivation waits for a guarded write already in flight, and later writes see it", async () => {
    const { cid } = await clientEndingSoon("Statuslock");
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let guarded!: () => void;
    const passedGuard = new Promise<void>((r) => (guarded = r));
    const write = withOrg(bcba, async (tx) => {
      await assertClientActive(tx, cid);
      guarded();
      await gate;
    });
    await passedGuard;
    let finished = false;
    const status = inactivate(cid).then(() => (finished = true));
    await new Promise((r) => setTimeout(r, 300));
    expect(finished).toBe(false);
    release();
    await write;
    await status;
    expect(finished).toBe(true);
    await expect(withOrg(bcba, (tx) => assertClientActive(tx, cid))).rejects.toMatchObject(blocked);
  });

  it("the database rejects an unknown status or an inactive client without a date", async () => {
    const { cid } = await clientEndingSoon("Statuscheck");
    await expect(
      withOrg(bcba, (tx) => tx.client.update({ where: { id: cid }, data: { status: "paused" } })),
    ).rejects.toThrow();
    await expect(
      withOrg(bcba, (tx) => tx.client.update({ where: { id: cid }, data: { status: "inactive" } })),
    ).rejects.toThrow();
  });

  it("another practice cannot see or change the status (RLS)", async () => {
    await expect(setClientStatus(otherBcba, golf.id, { status: "active" }, AS_OF)).rejects.toMatchObject({
      status: 404,
    });
    const theirs = await listClients(otherBcba, "inactive");
    expect(theirs.clients).toEqual([]);
    expect(theirs.counts.inactive).toBe(0);
    expect((await listClients(otherBcba, "active")).clients.map((c) => c.lastName)).toEqual(["Otherorg"]);
    expect((await clientStatusSummary(bcba, golf.id)).status).toBe("inactive");
  });
});

describe("inactive clients raise no alerts and have nothing due", () => {
  it("the seeded inactive client (Golf) never appears on the caseload, though its authorization has ended", async () => {
    const { events, clients, inactiveCount } = await caseload(bcba, AS_OF);
    expect(clients.map((c) => c.id)).not.toContain(golf.id);
    expect(events.map((e) => e.clientId)).not.toContain(golf.id);
    expect(inactiveCount).toBeGreaterThanOrEqual(1);
    const d = await clientDetail(bcba, golf.id, AS_OF);
    expect(d.inactive).toBe(true);
    expect(d.alerts).toEqual([]);
    expect(d.events).toEqual([]);
    // Everything stays readable.
    expect(d.auth?.authNumber).toBe("SYN-AUTH-4004");
    expect(d.sessions.length).toBeGreaterThan(0);
    expect(d.client.administrations).toHaveLength(1);
  });

  it("drops a client's alerts, due dates, and caseload tiles when inactive, and brings them back on reactivation", async () => {
    const { cid } = await clientEndingSoon("Statusalerts");
    const before = await caseload(bcba, AS_OF);
    expect(before.clients.map((c) => c.id)).toContain(cid);
    const kinds = before.events.filter((e) => e.clientId === cid).map((e) => e.kind);
    expect(kinds).toEqual(expect.arrayContaining(["auth_expiration", "auth_alert"]));
    const active = await clientDetail(bcba, cid, AS_OF);
    expect(active.alerts.some((a) => /until authorization ends/.test(a.message))).toBe(true);
    expect(active.events.length).toBeGreaterThan(0);

    await inactivate(cid);
    const after = await caseload(bcba, AS_OF);
    expect(after.clients.map((c) => c.id)).not.toContain(cid);
    expect(after.events.filter((e) => e.clientId === cid)).toEqual([]);
    expect(after.inactiveCount).toBe(before.inactiveCount + 1);
    const d = await clientDetail(bcba, cid, AS_OF);
    expect(d.alerts).toEqual([]);
    expect(d.events).toEqual([]);
    // The payor requirements page stays readable (a reference, not an alert).
    await expect(clientRequirements(bcba, cid, AS_OF)).resolves.toBeTruthy();

    await reactivate(cid);
    expect((await caseload(bcba, AS_OF)).events.filter((e) => e.clientId === cid).length).toBe(kinds.length);
    expect((await clientDetail(bcba, cid, AS_OF)).alerts.length).toBe(active.alerts.length);
  });
});

describe("an inactive client's figures are history, with nothing flagged or due", () => {
  it("the client, requirements, and packet pages show no failing rules, delivery flags, or due dates", async () => {
    const { cid } = await clientEndingSoon("Statushistory");
    const plan = await createPlan(bcba, cid, "reauth");
    const active = await clientDetail(bcba, cid, AS_OF);
    // While active, the empty authorization is under-delivered and some payor rule fails.
    expect(active.utilization.some((u) => u.flag === "under")).toBe(true);
    expect(active.ruleResults.some((r) => r.rawStatus === "fail")).toBe(true);
    const activeReq = await clientRequirements(bcba, cid, AS_OF);
    const reqItems = (r: typeof activeReq) => r.insurances.flatMap((i) => i.groups.flatMap((g) => g.items));
    expect(reqItems(activeReq).some((i) => i.status === "missing")).toBe(true);

    await inactivate(cid, { date: addDays(AS_OF, -10) });
    for (const asOf of [AS_OF, addDays(AS_OF, 90)]) {
      const d = await clientDetail(bcba, cid, asOf);
      expect(d.utilization.length).toBe(active.utilization.length);
      expect(d.utilization.every((u) => u.flag === null && u.weeks.every((w) => w.flag === null))).toBe(true);
      // Frozen at the inactive date: the expected amount stops growing.
      const later = (await clientDetail(bcba, cid, addDays(asOf, 30))).utilization;
      expect(later.map((u) => u.expectedToDate)).toEqual(d.utilization.map((u) => u.expectedToDate));
      expect(d.ruleResults.every((r) => r.status !== "fail" && r.status !== "warn")).toBe(true);
      expect(d.ruleResults.every((r) => r.rawStatus !== "fail" && r.rawStatus !== "warn")).toBe(true);
      expect(d.ruleResults.some((r) => /inactive since/.test(r.message))).toBe(true);
      expect(d.ruleResults.every((r) => !r.schedule)).toBe(true);

      const req = await clientRequirements(bcba, cid, asOf);
      expect(req.inactive).toBe(true);
      const items = reqItems(req);
      expect(items.every((i) => i.status !== "missing" && !i.schedule)).toBe(true);
      expect(JSON.stringify(items.map((i) => i.message))).not.toMatch(/overdue|due by|next due/);

      const pv = await packetView(bcba, plan.id, asOf);
      expect(pv.inactive).toBe(true);
      const rules = pv.checklist.filter((i) => i.source === "payor_rule" && i.key.startsWith("rule:"));
      expect(rules.every((i) => i.status !== "missing" && !i.notes)).toBe(true);
    }
  });
});

describe("the clients list has an Active and an Inactive tab", () => {
  it("splits clients by status with matching counts", async () => {
    const { cid } = await clientEndingSoon("Statuslist");
    await inactivate(cid);
    const act = await listClients(bcba, "active");
    const inact = await listClients(bcba, "inactive");
    expect(act.counts).toEqual(inact.counts);
    expect(act.clients).toHaveLength(act.counts.active);
    expect(inact.clients).toHaveLength(inact.counts.inactive);
    expect(inact.clients.map((c) => c.id)).toEqual(expect.arrayContaining([golf.id, cid]));
    expect(act.clients.map((c) => c.id)).not.toContain(golf.id);
    expect(act.clients.map((c) => c.id)).not.toContain(cid);
    expect(inact.clients.every((c) => c.status === "inactive" && c.inactiveSince && c.inactiveReason)).toBe(
      true,
    );
    // Defaults to the active tab.
    expect((await listClients(bcba)).clients.map((c) => c.id)).toEqual(act.clients.map((c) => c.id));
  });
});

describe("an inactive client takes no new records; everything stays readable", () => {
  it("drops an AI draft that finishes after the client was marked inactive", async () => {
    const { cid } = await clientEndingSoon("Statusdraft");
    const plan = await createPlan(bcba, cid, "initial");
    const view = await planView(bcba, plan.id, AS_OF);
    const section = view.sections.find((s) => !s.bcbaOnly && s.state !== "approved")!;
    // The model "writes" while a BCBA marks the client inactive.
    class InactivatingProvider extends MockProvider {
      override async complete(req: LlmRequest) {
        await inactivate(cid);
        return super.complete(req);
      }
    }
    setLlmProvider(new InactivatingProvider());
    await expect(draftSection(bcba, plan.id, section.key, AS_OF)).rejects.toMatchObject(blocked);
    const after = (await planView(bcba, plan.id, AS_OF)).sections.find((s) => s.key === section.key)!;
    expect(after.content).toBe(section.content);
    expect(after.state).toBe(section.state);
    const revisions = await withOrg(bcba, (tx) =>
      tx.planSectionRevision.count({ where: { sectionId: section.id, kind: "ai_draft" } }),
    );
    expect(revisions).toBe(0);
  });

  it("blocks new plans, sessions, goals, data, assessments, imports, draft edits, approval, and export", async () => {
    const { cid, authorizationId } = await clientEndingSoon("Statusblock");
    const goal = await addGoalFromTemplate(bcba, cid, templateId);
    const plan = await createPlan(bcba, cid, "initial");
    const session = await addSession(
      bcba,
      cid,
      {
        authorizationId,
        cptCode: "97151",
        date: addDays(AS_OF, -5),
        startMinute: 540,
        units: 4,
        providerRole: "BCBA",
        providerId: "BCBA-1",
        inPerson: true,
      },
      AS_OF,
    );
    const view = await planView(bcba, plan.id, AS_OF);
    const key = view.sections[0]!.key;
    // An import staged while active cannot be confirmed once inactive.
    const staged = await uploadVbmapp(
      bcba,
      cid,
      "sample_G_level1.xlsm",
      readFileSync("fixtures/vbmapp/sample_G_level1.xlsm"),
    );
    await inactivate(cid);

    const rejects = (p: Promise<unknown>) => expect(p).rejects.toMatchObject(blocked);
    await rejects(createPlan(bcba, cid, "reauth"));
    await rejects(
      addSession(
        bcba,
        cid,
        {
          authorizationId,
          cptCode: "97151",
          date: addDays(AS_OF, -4),
          startMinute: 540,
          units: 4,
          providerRole: "BCBA",
          providerId: "BCBA-1",
          inPerson: true,
        },
        AS_OF,
      ),
    );
    await rejects(deleteSession(bcba, cid, session.id));
    await rejects(addGoalFromTemplate(bcba, cid, templateId));
    await rejects(addDataPoint(bcba, goal.id, { date: addDays(AS_OF, -2), value: 40, trials: 10 }, AS_OF));
    await rejects(updateGoal(bcba, goal.id, { barriers: "None noted" }));
    await rejects(approveGoal(bcba, goal.id));
    await rejects(discontinueGoal(bcba, goal.id, { reason: "Services ended", date: AS_OF }, AS_OF));
    await rejects(
      createAssessment(
        bcba,
        cid,
        {
          typeKey: "srs_2",
          form: "school_age",
          respondent: "teacher",
          administeredOn: AS_OF,
          administeredBy: "BCBA-Q",
          scores: [
            { scaleKey: "total_t", value: 70 },
            { scaleKey: "sci", value: 69 },
          ],
        },
        AS_OF,
      ),
    );
    await rejects(
      uploadAssessmentImport(bcba, cid, {
        filename: "pddbi.txt",
        data: Buffer.from("Autism Composite: 63"),
        typeKey: "pddbi",
      }),
    );
    await rejects(
      uploadVbmapp(bcba, cid, "sample_G_level1.xlsm", readFileSync("fixtures/vbmapp/sample_G_level1.xlsm")),
    );
    await rejects(editSection(bcba, plan.id, key, "Edited after discharge.", AS_OF));
    await rejects(approveSection(bcba, plan.id, key, AS_OF));
    await rejects(setChecklistDone(bcba, plan.id, "anything", true));
    await rejects(exportPacketPdf(bcba, plan.id, AS_OF));
    await rejects(confirmImport(bcba, staged.importId, { stripPhi: true }));

    // Uploads are refused before the file is read: a broken file still gets the inactive refusal.
    const junk = Buffer.from("not a workbook or a letter");
    await rejects(uploadVbmapp(bcba, cid, "broken.xlsm", junk));
    await rejects(uploadLetter(bcba, cid, "scan.pdf", junk));
    await rejects(uploadAssessmentImport(bcba, cid, { filename: "scan.pdf", data: junk, typeKey: "pddbi" }));

    // Nothing was deleted, and everything stays readable.
    await expect(planView(bcba, plan.id, AS_OF)).resolves.toBeTruthy();
    const gv = await goalsView(bcba, cid, AS_OF);
    expect(gv.goals.map((g) => g.id)).toContain(goal.id);
    const d = await clientDetail(bcba, cid, AS_OF);
    expect(d.sessions.map((s) => s.id)).toContain(session.id);
    expect(d.client.plans.map((p) => p.id)).toContain(plan.id);
    expect(await auditRows("client:inactivate", cid)).toHaveLength(1);
    await expect(listAudit(bcba, 5)).resolves.toHaveLength(5);

    // Reactivated, the client takes new records again.
    await reactivate(cid);
    await expect(
      addDataPoint(bcba, goal.id, { date: addDays(AS_OF, -2), value: 40, trials: 10 }, AS_OF),
    ).resolves.toHaveProperty("id");
  });
});
