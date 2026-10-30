import { afterAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { withOrg } from "@/lib/db";
import { listAssessments } from "@/lib/services/assessments";
import {
  assessmentImportReview,
  confirmAssessmentImport,
  discardAssessmentImport,
  uploadAssessmentImport,
} from "@/lib/services/assessment-imports";
import { AS_OF, dataset } from "../helpers/synthetic-eval";
import { clientId, ctxAs } from "../helpers/ctx";

const bcba = ctxAs("BCBA");
const rbt = ctxAs("RBT");
const other = dataset.orgs[1]!;
const otherBcba = { orgId: other.id, userId: other.users[0]!.id, role: "BCBA" as const };
const fixture = (f: string) => readFileSync(`fixtures/assessments/${f}`);

/** Imports made here are removed afterwards so the seeded assessment lists stay as seeded. */
const made: string[] = [];
afterAll(async () => {
  await withOrg(bcba, async (tx) => {
    const ids = (
      await tx.assessment.findMany({ where: { importId: { in: made } }, select: { id: true } })
    ).map((a) => a.id);
    await tx.assessmentScore.deleteMany({ where: { assessmentId: { in: ids } } });
    await tx.assessment.deleteMany({ where: { id: { in: ids } } });
    await tx.assessmentImport.deleteMany({ where: { id: { in: made } } });
  });
});

const upload = (file: string, typeKey: string, module: string | null = null, ctx = bcba) =>
  uploadAssessmentImport(
    ctx,
    clientId("client3"),
    { filename: file, data: fixture(file), typeKey, module },
    AS_OF,
  ).then((r) => {
    made.push(r.importId);
    return r;
  });

/** What the review screen sends after the BCBA ticks every proposed score. */
async function reviewedBody(importId: string, over: Record<string, unknown> = {}) {
  const { proposal } = await assessmentImportReview(bcba, importId);
  return {
    administeredOn: proposal.administeredOn?.value ?? "2026-04-13",
    administeredBy: "AS",
    form: proposal.form?.key ?? null,
    respondent: proposal.respondent?.key ?? null,
    scores: proposal.scores.map((s) => ({
      scaleKey: s.scaleKey,
      value: s.value,
      possible: s.possible,
      reviewed: true,
    })),
    ...over,
  };
}

describe("assessment score imports", () => {
  it("import → review → confirm creates a confirmed assessment with provenance on every score", async () => {
    const up = await upload("vineland3_scores.pdf", "vineland_3");
    const review = await assessmentImportReview(bcba, up.importId);
    expect(review.import).toMatchObject({
      status: "pending",
      typeKey: "vineland_3",
      format: "pdf",
      mime: "application/pdf",
      phiDetected: false,
      // Never the uploaded name: report files are often named after the child.
      filename: "vineland_3.pdf",
    });
    expect(review.import.fileSha256).toMatch(/^[0-9a-f]{64}$/);
    // Stored: the proposal only, never the file's text.
    expect(JSON.stringify(review.import.parsed)).not.toContain("synthetic sample");

    const body = await reviewedBody(up.importId);
    // Every number must be checked: one unticked score blocks the confirmation.
    const unticked = {
      ...body,
      scores: body.scores.map((s, i) => (i === 2 ? { ...s, reviewed: false } : s)),
    };
    await expect(confirmAssessmentImport(bcba, up.importId, unticked, AS_OF)).rejects.toMatchObject({
      status: 422,
      issues: ["Communication: check this score against the file"],
    });
    // The RBT cannot confirm; out-of-range edits are rejected.
    await expect(confirmAssessmentImport(rbt, up.importId, body, AS_OF)).rejects.toMatchObject({
      status: 403,
    });
    const bad = {
      ...body,
      scores: body.scores.map((s) => (s.scaleKey === "abc" ? { ...s, value: 190 } : s)),
    };
    await expect(confirmAssessmentImport(bcba, up.importId, bad, AS_OF)).rejects.toMatchObject({
      status: 422,
      issues: ["Adaptive Behavior Composite must be between 20 and 140"],
    });

    // The BCBA corrects one value and adds Motor Skills by hand.
    const final = {
      ...body,
      scores: [
        ...body.scores.map((s) => (s.scaleKey === "coping" ? { ...s, value: 10 } : s)),
        { scaleKey: "motor", value: 72, possible: null, reviewed: true },
      ],
    };
    const res = await confirmAssessmentImport(bcba, up.importId, final, AS_OF);
    const a = await withOrg(bcba, (tx) =>
      tx.assessment.findUniqueOrThrow({ where: { id: res.assessmentId }, include: { scores: true } }),
    );
    expect(a).toMatchObject({
      typeKey: "vineland_3",
      source: "import",
      importId: up.importId,
      status: "confirmed",
      reviewerId: bcba.userId,
      form: "comprehensive_interview",
      respondent: "parent_caregiver",
      administeredBy: "AS",
    });
    expect(a.administeredOn.toISOString().slice(0, 10)).toBe("2026-04-13");
    expect(a.scores).toHaveLength(18);
    const prov = (k: string) => a.scores.find((s) => s.scaleKey === k)!.provenance as Record<string, unknown>;
    expect(prov("abc")).toEqual({
      importId: up.importId,
      format: "pdf",
      location: "page 1, line 8",
      matchedLabel: "Adaptive Behavior Composite",
      confidence: "high",
      proposed: { value: 71, possible: null },
      edited: false,
      reviewedBy: bcba.userId,
    });
    expect(prov("coping")).toMatchObject({ edited: true, proposed: { value: 9, possible: null } });
    expect(a.scores.find((s) => s.scaleKey === "coping")!.value).toBe(10);
    expect(prov("motor")).toMatchObject({ enteredByHand: true, location: null });

    const imp = await withOrg(bcba, (tx) =>
      tx.assessmentImport.findUniqueOrThrow({ where: { id: up.importId } }),
    );
    expect(imp).toMatchObject({ status: "confirmed", reviewerId: bcba.userId });
    await expect(confirmAssessmentImport(bcba, up.importId, final, AS_OF)).rejects.toMatchObject({
      status: 409,
    });

    const events = await withOrg(bcba, (tx) =>
      tx.auditEvent.findMany({ where: { entityId: up.importId }, orderBy: { createdAt: "asc" } }),
    );
    expect(events.map((e) => e.action)).toEqual(
      expect.arrayContaining(["assessment_import:upload", "assessment_import:confirm"]),
    );
    const list = await listAssessments(bcba, clientId("client3"));
    expect(list.items.find((i) => i.id === res.assessmentId)).toMatchObject({
      source: "import",
      status: "confirmed",
    });
    expect(list.pendingImports.some((p) => p.id === up.importId)).toBe(false);
  });

  it("a file with a name and birth date: only flags are stored, and confirming needs the acknowledgement", async () => {
    const up = await upload("pddbi_parent.txt", "pddbi");
    const imp = await withOrg(bcba, (tx) =>
      tx.assessmentImport.findUniqueOrThrow({ where: { id: up.importId } }),
    );
    expect(imp.phiDetected).toBe(true);
    const stored = JSON.stringify({ parsed: imp.parsed, flags: imp.flags, filename: imp.filename });
    for (const s of ["Charlie", "Testchild", "2019", "01/15"]) expect(stored).not.toContain(s);
    const body = await reviewedBody(up.importId);
    await expect(confirmAssessmentImport(bcba, up.importId, body, AS_OF)).rejects.toMatchObject({
      status: 422,
    });
    await confirmAssessmentImport(bcba, up.importId, { ...body, stripPhi: true }, AS_OF);
    const after = await withOrg(bcba, (tx) =>
      tx.assessmentImport.findUniqueOrThrow({ where: { id: up.importId } }),
    );
    expect(after.phiStripped).toBe(true);
  });

  it("two confirms of one import at once save one assessment", async () => {
    const up = await upload("ablls_r_areas.xlsx", "ablls_r");
    const body = await reviewedBody(up.importId);
    const results = await Promise.allSettled([
      confirmAssessmentImport(bcba, up.importId, body, AS_OF),
      confirmAssessmentImport(bcba, up.importId, body, AS_OF),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const failed = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect(failed.reason).toMatchObject({ status: 409 });
    expect(await withOrg(bcba, (tx) => tx.assessment.count({ where: { importId: up.importId } }))).toBe(1);
  });

  it("the uploaded file name is never stored, whatever it holds", async () => {
    const r = await uploadAssessmentImport(
      bcba,
      clientId("client3"),
      {
        filename: "Testchild_Charlie_DOB_2019-01-15_MBR123456789.txt",
        data: fixture("pddbi_parent.txt"),
        typeKey: "pddbi",
      },
      AS_OF,
    );
    made.push(r.importId);
    const imp = await withOrg(bcba, (tx) =>
      tx.assessmentImport.findUniqueOrThrow({ where: { id: r.importId } }),
    );
    expect(imp.filename).toBe("pddbi.txt");
    const list = await listAssessments(bcba, clientId("client3"));
    expect(JSON.stringify(list.pendingImports)).not.toMatch(/Testchild|2019|MBR/);
  });

  it("an image is read with local OCR; a discarded import saves nothing", async () => {
    const up = await upload("srs2_scores.png", "srs_2");
    expect(up.proposal.scores.map((s) => s.scaleKey)).toContain("total_t");
    const before = await withOrg(bcba, (tx) => tx.assessment.count({ where: { importId: up.importId } }));
    expect((await listAssessments(bcba, clientId("client3"))).pendingImports.map((p) => p.id)).toContain(
      up.importId,
    );
    await expect(discardAssessmentImport(rbt, up.importId)).rejects.toMatchObject({ status: 403 });
    await discardAssessmentImport(bcba, up.importId);
    await expect(discardAssessmentImport(bcba, up.importId)).rejects.toMatchObject({ status: 409 });
    expect(await withOrg(bcba, (tx) => tx.assessment.count({ where: { importId: up.importId } }))).toBe(
      before,
    );
    const body = await reviewedBody(up.importId);
    await expect(confirmAssessmentImport(bcba, up.importId, body, AS_OF)).rejects.toMatchObject({
      status: 409,
    });
  }, 60_000);

  it("checks the type, the module, permissions, and the org", async () => {
    await expect(upload("ablls_r_areas.xlsx", "vbmapp")).rejects.toMatchObject({ status: 422 });
    await expect(upload("afls_basic_living.csv", "afls")).rejects.toMatchObject({
      status: 422,
      message: "Choose the AFLS module",
    });
    await expect(upload("afls_basic_living.csv", "nope")).rejects.toMatchObject({ status: 422 });
    await expect(upload("ablls_r_areas.xlsx", "ablls_r", null, rbt)).rejects.toMatchObject({ status: 403 });
    // Another practice cannot see the client, or this practice's imports.
    await expect(upload("ablls_r_areas.xlsx", "ablls_r", null, otherBcba)).rejects.toMatchObject({
      status: 404,
    });
    const up = await upload("afls_basic_living.csv", "afls", "basic_living");
    await expect(assessmentImportReview(otherBcba, up.importId)).rejects.toMatchObject({ status: 404 });
    // A file whose contents do not match its name is rejected before anything is stored.
    await expect(
      uploadAssessmentImport(bcba, clientId("client3"), {
        filename: "scores.png",
        data: fixture("vineland3_scores.pdf"),
        typeKey: "vineland_3",
      }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("score-of-possible imports keep the possible points", async () => {
    const up = await upload("ablls_r_areas.xlsx", "ablls_r");
    const res = await confirmAssessmentImport(bcba, up.importId, await reviewedBody(up.importId), AS_OF);
    const a = await withOrg(bcba, (tx) =>
      tx.assessment.findUniqueOrThrow({ where: { id: res.assessmentId }, include: { scores: true } }),
    );
    expect(a.scores.find((s) => s.scaleKey === "receptive_language")).toMatchObject({
      value: 9,
      possible: 102,
    });
    expect(a.administeredOn.toISOString().slice(0, 10)).toBe("2026-10-08");
  });
});
