import { describe, expect, it } from "vitest";
import { withOrg } from "@/lib/db";
import { ForbiddenError } from "@/lib/log";
import {
  confirmAssessment,
  createAssessment,
  deleteAssessment,
  listAssessments,
  updateAssessment,
} from "@/lib/services/assessments";
import { AS_OF, dataset } from "../helpers/synthetic-eval";
import { clientId, ctxAs, org } from "../helpers/ctx";

const bcba = ctxAs("BCBA");
const rbt = ctxAs("RBT");
const coord = ctxAs("AUTH_COORDINATOR");
const parent = ctxAs("PARENT");
const other = dataset.orgs[1]!;
const otherBcba = { orgId: other.id, userId: other.users[0]!.id, role: "BCBA" as const };

const srs = (over: Record<string, unknown> = {}) => ({
  typeKey: "srs_2",
  form: "school_age",
  respondent: "teacher",
  administeredOn: "2026-10-01",
  administeredBy: "BCBA-Q",
  scores: [
    { scaleKey: "total_t", value: 70 },
    { scaleKey: "sci", value: 69 },
  ],
  ...over,
});

describe("seeded assessments", () => {
  it("Charlie (TRICARE) has Vineland-3 twice, SRS-2, PDDBI parent, and PSI-4, listed newest first", async () => {
    const { items, groups } = await listAssessments(bcba, clientId("client3"));
    const manual = items.filter((i) => i.source === "manual");
    expect(manual.map((i) => i.typeKey).sort()).toEqual(
      ["pddbi", "psi_4", "srs_2", "vineland_3", "vineland_3"].sort(),
    );
    const dates = items.map((i) => i.administeredOn ?? "");
    expect(dates).toEqual([...dates].sort().reverse());
    const vineland = groups.find((g) => g.typeKey === "vineland_3")!;
    expect(vineland.items).toHaveLength(2);
    const abc = vineland.progress!.rows.find((r) => r.key === "abc")!;
    expect(abc.change).toBe(5);
    expect(groups.find((g) => g.typeKey === "pddbi")!.label).toBe("PDDBI · Parent Form");
    expect(manual.every((i) => i.status === "confirmed")).toBe(true);
  });

  it("Alpha has an ABLLS-R; Bravo keeps two VB-MAPP administrations and gets an AFLS draft, in one list", async () => {
    const alpha = await listAssessments(bcba, clientId("client1"));
    // Other test files may import more VB-MAPP administrations for Alpha.
    expect(new Set(alpha.items.map((i) => i.typeKey))).toEqual(new Set(["ablls_r", "vbmapp"]));
    expect(alpha.items.find((i) => i.typeKey === "ablls_r")!.summary[0]!.computed).toBe(true);

    const bravo = await listAssessments(bcba, clientId("client2"));
    expect(bravo.items.map((i) => [i.typeKey, i.source, i.status])).toEqual([
      ["afls", "manual", "draft"],
      ["vbmapp", "vbmapp_import", "confirmed"],
      ["vbmapp", "vbmapp_import", "confirmed"],
    ]);
    const vb = bravo.groups.find((g) => g.typeKey === "vbmapp")!;
    expect(vb.items.map((i) => i.adminNumber)).toEqual([2, 1]);
    expect(vb.items[0]!.href).toBe(`/clients/${clientId("client2")}/vbmapp#admin-2`);
    expect(vb.progress!.rows[0]!.key).toBe("total");
    expect(bravo.items.find((i) => i.typeKey === "afls")!.moduleName).toBe("Basic Living Skills");
  });
});

describe("assessment entry, confirmation, and locking", () => {
  it("creates a draft, edits it, confirms it (reviewer recorded), then locks it", async () => {
    const cid = clientId("client1");
    const { id } = await createAssessment(bcba, cid, srs(), AS_OF);
    let row = await withOrg(bcba, (tx) =>
      tx.assessment.findUniqueOrThrow({ where: { id }, include: { scores: true } }),
    );
    expect(row).toMatchObject({
      status: "draft",
      source: "manual",
      createdById: bcba.userId,
      reviewerId: null,
    });
    expect(row.scores).toHaveLength(2);

    await updateAssessment(bcba, cid, id, srs({ scores: [{ scaleKey: "total_t", value: 68 }] }), AS_OF);
    row = await withOrg(bcba, (tx) =>
      tx.assessment.findUniqueOrThrow({ where: { id }, include: { scores: true } }),
    );
    expect(row.scores.map((s) => [s.scaleKey, s.value])).toEqual([["total_t", 68]]);

    await confirmAssessment(bcba, cid, id);
    row = await withOrg(bcba, (tx) =>
      tx.assessment.findUniqueOrThrow({ where: { id }, include: { scores: true } }),
    );
    expect(row.status).toBe("confirmed");
    expect(row.reviewerId).toBe(bcba.userId);
    expect(row.reviewedAt).toBeInstanceOf(Date);

    await expect(updateAssessment(bcba, cid, id, srs(), AS_OF)).rejects.toMatchObject({ status: 409 });
    await expect(deleteAssessment(bcba, cid, id)).rejects.toMatchObject({ status: 409 });
    await expect(confirmAssessment(bcba, cid, id)).rejects.toMatchObject({ status: 409 });
  });

  it("will not confirm an assessment with no scores", async () => {
    const cid = clientId("client1");
    const { id } = await createAssessment(bcba, cid, srs({ scores: [] }), AS_OF);
    await expect(confirmAssessment(bcba, cid, id)).rejects.toMatchObject({ status: 422 });
    await deleteAssessment(bcba, cid, id);
    expect(await withOrg(bcba, (tx) => tx.assessment.findUnique({ where: { id } }))).toBeNull();
  });

  it("an edit cannot change the assessment type", async () => {
    const cid = clientId("client1");
    const { id } = await createAssessment(bcba, cid, srs(), AS_OF);
    await expect(
      updateAssessment(
        bcba,
        cid,
        id,
        { ...srs(), typeKey: "pddbi", form: "parent", scores: [{ scaleKey: "autism_composite", value: 60 }] },
        AS_OF,
      ),
    ).rejects.toMatchObject({ status: 422 });
  });

  it("rejects invalid scores and future dates with one sentence per problem", async () => {
    await expect(
      createAssessment(
        bcba,
        clientId("client1"),
        srs({ administeredOn: "2026-11-15", scores: [{ scaleKey: "total_t", value: 200 }] }),
        AS_OF,
      ),
    ).rejects.toMatchObject({
      status: 422,
      issues: [
        "The administration date cannot be in the future (today is 2026-10-29)",
        "Total must be between 0 and 150",
      ],
    });
  });

  it("an edit or delete names the client: another client's assessment is not found", async () => {
    const { id } = await createAssessment(bcba, clientId("client1"), srs(), AS_OF);
    await expect(updateAssessment(bcba, clientId("client2"), id, srs(), AS_OF)).rejects.toMatchObject({
      status: 404,
    });
    await expect(deleteAssessment(bcba, clientId("client2"), id)).rejects.toMatchObject({ status: 404 });
  });

  it("audit-logs each step with ids and catalog keys only", async () => {
    const cid = clientId("client1");
    const before = new Date();
    const { id } = await createAssessment(bcba, cid, srs({ notes: "Retest with the teacher form." }), AS_OF);
    await confirmAssessment(bcba, cid, id);
    const rows = await withOrg(bcba, (tx) =>
      tx.auditEvent.findMany({ where: { createdAt: { gte: before } }, orderBy: { createdAt: "asc" } }),
    );
    const semantic = rows.filter((r) => r.entityId === id && r.action.startsWith("assessment:"));
    expect(semantic.map((r) => r.action)).toEqual(["assessment:create", "assessment:confirm"]);
    expect(semantic[0]!.meta).toEqual({ typeKey: "srs_2", module: null, scores: 2 });
    expect(rows.some((r) => r.entityType === "Assessment" && r.action === "write:create")).toBe(true);
    expect(rows.some((r) => r.entityType === "AssessmentScore" && r.action === "write:createMany")).toBe(
      true,
    );
    expect(JSON.stringify(rows.map((r) => r.meta))).not.toMatch(/Retest|teacher form/);
  });
});

describe("assessment permissions mirror VB-MAPP", () => {
  it("an RBT can read the list but cannot enter, confirm, or delete", async () => {
    const cid = clientId("client3");
    expect((await listAssessments(rbt, cid)).items.length).toBeGreaterThan(0);
    await expect(createAssessment(rbt, cid, srs(), AS_OF)).rejects.toBeInstanceOf(ForbiddenError);
    const { id } = await createAssessment(bcba, cid, srs(), AS_OF);
    await expect(confirmAssessment(rbt, cid, id)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(updateAssessment(rbt, cid, id, srs(), AS_OF)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(deleteAssessment(rbt, cid, id)).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("a parent cannot even list assessments; the coordinator cannot enter them", async () => {
    await expect(listAssessments(parent, clientId("client3"))).rejects.toBeInstanceOf(ForbiddenError);
    await expect(createAssessment(coord, clientId("client3"), srs(), AS_OF)).rejects.toBeInstanceOf(
      ForbiddenError,
    );
  });
});

describe("assessment tenancy (RLS)", () => {
  it("another practice cannot see, list, or add to this practice's assessments", async () => {
    const cid = clientId("client3");
    await expect(listAssessments(otherBcba, cid)).rejects.toMatchObject({ status: 404 });
    await expect(createAssessment(otherBcba, cid, srs(), AS_OF)).rejects.toMatchObject({ status: 404 });
    const raw = await withOrg(otherBcba, (tx) =>
      tx.$queryRawUnsafe<unknown[]>(
        `SELECT a.id FROM assessment a UNION ALL SELECT s.id FROM assessment_score s`,
      ),
    );
    expect(raw).toEqual([]);
  });

  it("rejects a row written into another org, even with a known parent id", async () => {
    const assessmentId = dataset.orgs[0]!.clients.find((c) => c.key === "client3")!.assessments[0]!.id;
    await expect(
      withOrg(otherBcba, (tx) =>
        tx.assessmentScore.create({
          data: { orgId: org.id, assessmentId, scaleKey: "abc", value: 90 },
        }),
      ),
    ).rejects.toThrow(/row-level security/i);
    const updated = await withOrg(otherBcba, (tx) =>
      tx.assessment.updateMany({ where: { id: assessmentId }, data: { status: "draft" } }),
    );
    expect(updated.count).toBe(0);
  });
});

describe("assessment database constraints", () => {
  it("a score cannot exceed its possible, and a confirmed row needs a reviewer", async () => {
    const { id } = await createAssessment(bcba, clientId("client1"), srs(), AS_OF);
    await expect(
      withOrg(bcba, (tx) =>
        tx.assessmentScore.create({
          data: { orgId: org.id, assessmentId: id, scaleKey: "x_area", value: 12, possible: 10 },
        }),
      ),
    ).rejects.toThrow(/assessment_score_possible_check/);
    await expect(
      withOrg(bcba, (tx) => tx.assessment.update({ where: { id }, data: { status: "confirmed" } })),
    ).rejects.toThrow(/assessment_confirmed_reviewer_check/);
    await expect(
      withOrg(bcba, (tx) =>
        tx.assessment.update({ where: { id }, data: { administeredBy: "Avery Sample" } }),
      ),
    ).rejects.toThrow(/assessment_administered_by_check/);
  });
});
