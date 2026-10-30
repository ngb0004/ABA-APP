import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { PrismaClient } from "@prisma/client";
import { withOrg } from "@/lib/db";
import { loadRules } from "@/lib/services/payors";
import {
  checkSourcesNow,
  revokeRuleVerification,
  uploadOfficialCopy,
  verifyRuleWithQuote,
  watchAllOrgs,
  watchOrgSources,
} from "@/lib/services/rules-watch";
import { syncPayorLibrary } from "@/lib/payors/library";
import { loadPayorSeed } from "@/lib/payors/load";
import { authenticator } from "otplib";
import { POST as revokeRoute } from "@/app/api/payors/rules/[id]/revoke/route";
import { POST as verifyRoute } from "@/app/api/payors/rules/[id]/verify/route";
import { loginWithPassword, SESSION_COOKIE, verifyMfa } from "@/lib/auth/session";
import { DEMO_PASSWORD } from "../../seed/synthetic/dataset";
import { ctxAs, curatorCtx, curatorUser, org, userOf } from "../helpers/ctx";
import { dataset } from "../helpers/synthetic-eval";
import { fakeFetch } from "../helpers/fake-fetch";

const bcba = ctxAs("BCBA");
const other = dataset.orgs[1]!;
const otherBcba = { orgId: other.id, userId: other.users[0]!.id, role: "BCBA" as const };
// Verifying rules and uploading official copies is curation: a platform curator does it.
const curator = curatorCtx;
const rulesOf = (payorKey: string) =>
  withOrg(bcba, async (tx) =>
    loadRules(
      tx,
      (await tx.payor.findUniqueOrThrow({ where: { orgId_key: { orgId: org.id, key: payorKey } } })).id,
    ),
  );

// These tests play out a quarter turning over: our rules cite Georgia's July manual, and the
// watcher finds the October one (the fixture).
const julySeed = () => {
  const s = loadPayorSeed();
  s.documents.ga_medicaid_asd_manual = {
    ...s.documents.ga_medicaid_asd_manual!,
    version: "2026-07-01",
    effective_date: "2026-07-01",
  };
  return s;
};

beforeAll(async () => {
  await withOrg(bcba, (tx) => syncPayorLibrary(tx, org.id, julySeed()));
  await watchOrgSources(bcba, { fetcher: fakeFetch() });
});
afterAll(async () => {
  await withOrg(bcba, (tx) => syncPayorLibrary(tx, org.id));
});

describe("source watcher", () => {
  it("finds the current Georgia manual by title through the index page and records its change log", async () => {
    const doc = await withOrg(bcba, (tx) =>
      tx.payorDocument.findFirstOrThrow({
        where: { key: "ga_medicaid_asd_manual" },
        include: { snapshots: true },
      }),
    );
    expect(doc.health).toBe("changed"); // newer than the July version our rules cite
    expect(doc.snapshots).toHaveLength(1);
    const s = doc.snapshots[0]!;
    expect(s.resolvedUrl).toMatch(/Autism%20Spectrum%20Disorder%20Q4-October%202026/);
    expect(s.versionLabel).toBe("Effective 2026-10-01");
    expect(s.nextRevision?.toISOString().slice(0, 10)).toBe("2027-01-01");
    expect((s.revisions as unknown[]).length).toBeGreaterThanOrEqual(16);
  });

  it("marks unreachable documents broken, never unchanged", async () => {
    const doc = await withOrg(bcba, (tx) =>
      tx.payorDocument.findFirstOrThrow({ where: { key: "umr_aba_doc_reqs" } }),
    );
    expect(doc.health).toBe("broken");
    expect(doc.lastError).toBe("HTTP 404");
    const checklist = await withOrg(bcba, (tx) =>
      tx.payorDocument.findFirstOrThrow({ where: { key: "checklist_2026" } }),
    );
    expect(checklist.health).toBe("unknown"); // secondary source with nothing to watch
  });

  it("does not create a new snapshot when nothing changed, and treats empty or challenge pages as broken", async () => {
    await watchOrgSources(bcba, { fetcher: fakeFetch() });
    const n = await withOrg(bcba, (tx) =>
      tx.payorDocumentSnapshot.count({ where: { document: { key: "ga_medicaid_asd_manual" } } }),
    );
    expect(n).toBe(1);
    const aetnaUrl = "https://www.aetna.com/cpb/medical/data/600_699/0648.html";
    const res = await watchOrgSources(bcba, {
      fetcher: fakeFetch({ [aetnaUrl]: { status: 202, body: "" } }),
    });
    expect(res.find((r) => r.key === "aetna_cpb_0648")).toMatchObject({ health: "broken" });
    await watchOrgSources(bcba, { fetcher: fakeFetch() });
  });

  it("a renamed document keeps its row and fetched copies", async () => {
    const before = await withOrg(bcba, (tx) =>
      tx.payorDocument.findFirstOrThrow({
        where: { key: "aetna_cpb_0648" },
        include: { _count: { select: { snapshots: true } } },
      }),
    );
    expect(before._count.snapshots).toBeGreaterThan(0);
    const renamed = julySeed();
    renamed.documents.aetna_cpb_0648_v2 = {
      ...renamed.documents.aetna_cpb_0648!,
      formerly: ["aetna_cpb_0648"],
    };
    delete renamed.documents.aetna_cpb_0648;
    for (const p of renamed.payors)
      for (const r of [...p.rules, ...p.extra_rules])
        if (r.source === "aetna_cpb_0648") r.source = "aetna_cpb_0648_v2";
    await withOrg(bcba, (tx) => syncPayorLibrary(tx, org.id, renamed));
    const after = await withOrg(bcba, (tx) =>
      tx.payorDocument.findFirstOrThrow({
        where: { key: "aetna_cpb_0648_v2" },
        include: { _count: { select: { snapshots: true } } },
      }),
    );
    expect(after.id).toBe(before.id);
    expect(after._count.snapshots).toBe(before._count.snapshots);
    // And back.
    const back = julySeed();
    back.documents.aetna_cpb_0648 = { ...back.documents.aetna_cpb_0648!, formerly: ["aetna_cpb_0648_v2"] };
    await withOrg(bcba, (tx) => syncPayorLibrary(tx, org.id, back));
    const restored = await withOrg(bcba, (tx) =>
      tx.payorDocument.findFirstOrThrow({ where: { key: "aetna_cpb_0648" } }),
    );
    expect(restored.id).toBe(before.id);
  });

  it("the scheduled run covers every org through app_org_ids()", async () => {
    const all = await watchAllOrgs(fakeFetch());
    expect(all.map((r) => r.orgId).sort()).toEqual([...new Set(all.map((r) => r.orgId))].sort());
    expect(all.length).toBeGreaterThanOrEqual(2);
  });
});

describe("rule trust from sources", () => {
  it("flags exactly the Georgia rules whose cited sections changed in Q4, with the payor's description", async () => {
    const ga = await rulesOf("ga_medicaid");
    const by = (pred: (r: (typeof ga)[number]) => boolean) => ga.filter(pred);
    const dx = by((r) => r.type === "required_document" && r.params.doc === "Diagnostic evaluation")[0]!;
    expect(dx.trust!.status).toBe("stale");
    expect(dx.trust!.reasons.join(" ")).toMatch(
      /Section 802 changed 2026-10-01: Modified to add Early Start Denver Model/,
    );
    const cover = by((r) => r.type === "required_document" && /Appendix D/.test(String(r.params.doc)))[0]!;
    expect(cover.trust!.status).toBe("stale");
    const portal = by((r) => r.type === "submission_channel")[0]!;
    expect(portal.trust!.status).toBe("unverified"); // Appendix E: nothing listed in Q4
    // Checklist-only, but Q4 added an in-person supervision provision: flagged for re-check.
    const supervision = by((r) => r.type === "supervision_ratio")[0]!;
    expect(supervision.trust).toMatchObject({ status: "stale", tier: "T5" });
    expect(supervision.trust!.reasons[0]).toMatch(
      /601.3.1 \(2026-10-01\) Add a provision related to in-person supervision/,
    );
    expect(ga.every((r) => !r.verified)).toBe(true);
  });

  it("inherited copies (Amerigroup) share the parent's trust", async () => {
    const am = await rulesOf("amerigroup");
    const inherited = am.find(
      (r) =>
        r.inheritedFrom === "ga_medicaid" &&
        r.type === "required_document" &&
        r.params.doc === "Diagnostic evaluation",
    )!;
    expect(inherited.lineageKey).toBe(
      (await rulesOf("ga_medicaid")).find(
        (r) => r.type === "required_document" && r.params.doc === "Diagnostic evaluation",
      )!.lineageKey,
    );
    expect(inherited.trust!.status).toBe("stale");
  });
});

describe("verify with proof", () => {
  const QUOTE = "email it to: ABA@Evernorth.com* (preferred)";

  it("only a curator can verify, the quote must be in the current document, and numbers must appear in it", async () => {
    const rule = (await rulesOf("cigna_evernorth")).find((r) => r.type === "submission_channel")!;
    await expect(
      verifyRuleWithQuote(ctxAs("AUTH_COORDINATOR"), rule.id, { quote: QUOTE }),
    ).rejects.toMatchObject({ status: 403 });
    // A practice's BCBA is not a curator, even with the real quote.
    await expect(verifyRuleWithQuote(bcba, rule.id, { quote: QUOTE })).rejects.toMatchObject({ status: 403 });
    await expect(
      verifyRuleWithQuote(curator, rule.id, { quote: "submit everything by carrier pigeon to the plan" }),
    ).rejects.toMatchObject({ status: 422 });
    const limit = (await rulesOf("cigna_evernorth")).find((r) => r.type === "unit_limit")!;
    const evernorth = await withOrg(bcba, (tx) =>
      tx.payorDocument.findFirstOrThrow({ where: { key: "evernorth_aba_pa_928213d" } }),
    );
    await expect(
      verifyRuleWithQuote(curator, limit.id, { quote: QUOTE, documentId: evernorth.id }),
    ).rejects.toThrow(/Missing: 97151, 6/);
    // The checklist can never verify a rule.
    const checklist = await withOrg(bcba, (tx) =>
      tx.payorDocument.findFirstOrThrow({ where: { key: "checklist_2026" } }),
    );
    await expect(
      verifyRuleWithQuote(curator, limit.id, { quote: QUOTE, documentId: checklist.id }),
    ).rejects.toThrow(/secondary source/);
  });

  it("verifies with a real sentence from the Evernorth form, then revokes", async () => {
    const rule = (await rulesOf("cigna_evernorth")).find((r) => r.type === "submission_channel")!;
    await verifyRuleWithQuote(curator, rule.id, { quote: QUOTE });
    let now = (await rulesOf("cigna_evernorth")).find((r) => r.id === rule.id)!;
    expect(now.trust).toMatchObject({ status: "verified", tier: "T1" });
    expect(now.verified).toBe(true);
    await revokeRuleVerification(curator, rule.id, "Form revised");
    now = (await rulesOf("cigna_evernorth")).find((r) => r.id === rule.id)!;
    expect(now.trust!.status).toBe("unverified");
    await verifyRuleWithQuote(curator, rule.id, { quote: QUOTE });
  });

  it("one verification covers every practice whose copy of the document is the same", async () => {
    // The other practice (no curator among its members) checks its own sources.
    await watchOrgSources(otherBcba, { fetcher: fakeFetch() });
    const theirs = async () => {
      const p = await withOrg(otherBcba, (tx) =>
        tx.payor.findUniqueOrThrow({ where: { orgId_key: { orgId: other.id, key: "cigna_evernorth" } } }),
      );
      const rules = await withOrg(otherBcba, (tx) => loadRules(tx, p.id));
      return rules.find((r) => r.type === "submission_channel")!;
    };
    const rule = (await rulesOf("cigna_evernorth")).find((r) => r.type === "submission_channel")!;
    await revokeRuleVerification(curator, rule.id, "Start over");
    expect((await theirs()).trust!.status).toBe("unverified");
    const ev = await verifyRuleWithQuote(curator, rule.id, { quote: QUOTE });
    expect(ev.practices).toEqual({ verified: 2, differentCopy: 0 });
    expect((await theirs()).trust).toMatchObject({ status: "verified", tier: "T1" });
    // Recorded in the other practice's own audit log, as the curator.
    const theirId = (await theirs()).id;
    const logged = await withOrg(otherBcba, (tx) =>
      tx.auditEvent.findFirstOrThrow({
        where: { action: "payor_rule:verify", entityId: theirId },
        orderBy: { createdAt: "desc" },
      }),
    );
    expect(logged.userId).toBe(curator.userId);
    await revokeRuleVerification(curator, rule.id, "Form revised");
    expect((await theirs()).trust!.status).toBe("unverified");
    expect((await rulesOf("cigna_evernorth")).find((r) => r.id === rule.id)!.trust!.status).toBe(
      "unverified",
    );
    await verifyRuleWithQuote(curator, rule.id, { quote: QUOTE });
  });

  it("the verify and revoke API routes return 403 to a practice BCBA and work for a curator", async () => {
    const rule = (await rulesOf("cigna_evernorth")).find((r) => r.type === "submission_channel")!;
    const call = async (path: string, token: string, body: unknown) => {
      const handler = path.endsWith("/verify") ? verifyRoute : revokeRoute;
      const res = await handler(
        new Request(`http://localhost${path}`, {
          method: "POST",
          headers: { cookie: `${SESSION_COOKIE}=${token}`, "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
        { params: Promise.resolve({ id: rule.id }) },
      );
      return { status: res.status, body: (await res.json()) as Record<string, unknown> };
    };
    const signIn = async (u: { email: string; totpSecret: string }) => {
      const s = await loginWithPassword(u.email, DEMO_PASSWORD);
      await verifyMfa(s!.token, authenticator.generate(u.totpSecret));
      return s!.token;
    };
    const bcbaToken = await signIn(userOf("BCBA"));
    const curatorToken = await signIn(curatorUser);
    const denied = await call(`/api/payors/rules/${rule.id}/verify`, bcbaToken, { quote: QUOTE });
    expect(denied.status).toBe(403);
    expect(String(denied.body.error)).toMatch(/Report a problem/);
    expect((await call(`/api/payors/rules/${rule.id}/revoke`, bcbaToken, {})).status).toBe(403);
    expect(
      (await call(`/api/payors/rules/${rule.id}/revoke`, curatorToken, { note: "re-check" })).status,
    ).toBe(200);
    const ok = await call(`/api/payors/rules/${rule.id}/verify`, curatorToken, { quote: QUOTE });
    expect(ok.status).toBe(200);
    expect(ok.body.evidenceId).toBeTruthy();
    const now = (await rulesOf("cigna_evernorth")).find((r) => r.id === rule.id)!;
    expect(now.trust!.status).toBe("verified");
  });

  it("evidence is append-only, even for the table owner", async () => {
    await expect(
      withOrg(bcba, (tx) => tx.$executeRawUnsafe(`UPDATE rule_evidence SET quote = 'x'`)),
    ).rejects.toThrow();
    const owner = new PrismaClient({ datasourceUrl: process.env.DIRECT_DATABASE_URL });
    try {
      await expect(owner.$executeRawUnsafe(`DELETE FROM rule_evidence`)).rejects.toThrow(/append-only/);
    } finally {
      await owner.$disconnect();
    }
  });

  it("reordering the payor file never moves a verification; editing a rule's numbers detaches it", async () => {
    const cigna = () => rulesOf("cigna_evernorth");
    const channel = (await cigna()).find((r) => r.type === "submission_channel")!;
    expect(channel.verified).toBe(true);
    const seed = julySeed();
    const reordered = structuredClone(seed);
    const p = reordered.payors.find((x: { id: string }) => x.id === "cigna_evernorth")!;
    p.rules.reverse();
    await withOrg(bcba, (tx) => syncPayorLibrary(tx, org.id, reordered));
    const after = await cigna();
    expect(after.filter((r) => r.verified).map((r) => r.type)).toEqual(["submission_channel"]);
    // Change what the rule says: the old evidence no longer applies.
    const edited = structuredClone(seed);
    const rule = edited.payors
      .find((x) => x.id === "cigna_evernorth")!
      .rules.find((r) => r.type === "submission_channel")!;
    rule.params = { ...rule.params, address: "someone-else@example.test" };
    await withOrg(bcba, (tx) => syncPayorLibrary(tx, org.id, edited));
    expect((await cigna()).find((r) => r.type === "submission_channel")!.verified).toBe(false);
    // Restore the real library: the original rule's evidence applies again.
    await withOrg(bcba, (tx) => syncPayorLibrary(tx, org.id, seed));
    expect((await cigna()).find((r) => r.type === "submission_channel")!.verified).toBe(true);
  });

  it("rules not yet synced (blank lineage) never pick up evidence and cannot be verified", async () => {
    const rule = (await rulesOf("cigna_evernorth")).find((r) => r.type === "form_address")!;
    await withOrg(bcba, (tx) => tx.payorRule.update({ where: { id: rule.id }, data: { lineageKey: "" } }));
    await expect(
      verifyRuleWithQuote(curator, rule.id, { quote: "email it to: ABA@Evernorth.com* (preferred)" }),
    ).rejects.toMatchObject({ status: 409 });
    expect((await rulesOf("cigna_evernorth")).find((r) => r.id === rule.id)!.verified).toBe(false);
    await withOrg(bcba, (tx) => syncPayorLibrary(tx, org.id));
  });

  it("checking sources now is a BCBA action", async () => {
    await expect(checkSourcesNow(ctxAs("RBT"), fakeFetch())).rejects.toMatchObject({ status: 403 });
    expect((await checkSourcesNow(bcba, fakeFetch())).length).toBeGreaterThan(5);
  });
});

describe("uploaded official copies (documents with no public URL)", () => {
  const pdf = (name: string) => readFileSync(`fixtures/payor-docs/${name}`);
  const docByKey = (key: string) =>
    withOrg(bcba, (tx) => tx.payorDocument.findFirstOrThrow({ where: { key } }));
  const HANDBOOK = "tricare_east_provider_handbook_2026";
  const outcomeRule = async () =>
    (await rulesOf("tricare_east")).find(
      (r) => r.type === "outcome_measure_schedule" && r.source.key === HANDBOOK,
    )!;

  it("before an upload, its rules say to upload the document", async () => {
    const r = await outcomeRule();
    expect(r.trust!.status).toBe("unverified");
    expect(r.trust!.reasons[0]).toMatch(/no public copy; not yet confirmed/);
    expect(r.source.quote).toMatch(/Vineland 3 and SRS-2 are due every year/);
    expect(r.source.page).toBe("30");
  });

  it("only a curator can upload, only to unwatched official documents, and only a text PDF", async () => {
    const doc = await docByKey(HANDBOOK);
    const data = pdf("synthetic-handbook.pdf");
    await expect(uploadOfficialCopy(ctxAs("AUTH_COORDINATOR"), doc.id, { data })).rejects.toMatchObject({
      status: 403,
    });
    await expect(uploadOfficialCopy(bcba, doc.id, { data })).rejects.toMatchObject({ status: 403 });
    const watched = await docByKey("aetna_cpb_0648");
    await expect(uploadOfficialCopy(curator, watched.id, { data })).rejects.toMatchObject({ status: 409 });
    const checklist = await docByKey("checklist_2026");
    await expect(uploadOfficialCopy(curator, checklist.id, { data })).rejects.toMatchObject({ status: 422 });
    await expect(
      uploadOfficialCopy(curator, doc.id, { data: Buffer.from("not a pdf at all ".repeat(50)) }),
    ).rejects.toMatchObject({ status: 422 });
    await expect(
      uploadOfficialCopy(curator, doc.id, { data, effectiveDate: "next Tuesday" }),
    ).rejects.toMatchObject({ status: 422 });
  });

  it("rejects anything that looks like a client's record, and stores nothing", async () => {
    const doc = await docByKey(HANDBOOK);
    await expect(
      uploadOfficialCopy(curator, doc.id, { data: pdf("synthetic-client-letter.pdf") }),
    ).rejects.toThrow(/client's information/);
    const n = await withOrg(bcba, (tx) => tx.payorDocumentSnapshot.count({ where: { documentId: doc.id } }));
    expect(n).toBe(0);
  });

  it("is off on the demo site", async () => {
    const doc = await docByKey(HANDBOOK);
    process.env.DEMO_MODE = "true";
    try {
      await expect(
        uploadOfficialCopy(curator, doc.id, { data: pdf("synthetic-handbook.pdf") }),
      ).rejects.toMatchObject({ status: 403 });
    } finally {
      delete process.env.DEMO_MODE;
    }
  });

  it("an uploaded copy lets a BCBA verify rules against it, for at most 90 days", async () => {
    const doc = await docByKey(HANDBOOK);
    const up = await uploadOfficialCopy(curator, doc.id, {
      data: pdf("synthetic-handbook.pdf"),
      versionLabel: "2026",
    });
    expect(up.unchanged).toBe(false);
    const snap = await withOrg(bcba, (tx) =>
      tx.payorDocumentSnapshot.findFirstOrThrow({ where: { documentId: doc.id } }),
    );
    expect(snap).toMatchObject({ origin: "upload", uploadedById: curator.userId, versionLabel: "2026" });
    expect(await uploadOfficialCopy(curator, doc.id, { data: pdf("synthetic-handbook.pdf") })).toMatchObject({
      unchanged: true,
    });
    // The watcher leaves uploaded documents alone.
    const checks = await watchOrgSources(bcba, { fetcher: fakeFetch() });
    expect(checks.some((c) => c.key === HANDBOOK)).toBe(false);

    const rule = await outcomeRule();
    await verifyRuleWithQuote(curator, rule.id, { quote: rule.source.quote! });
    const after = await outcomeRule();
    expect(after.trust).toMatchObject({ status: "verified", tier: "T1" });
    const days = (Date.parse(after.trust!.verifiedUntil!) - Date.now()) / 86_400_000;
    expect(days).toBeLessThanOrEqual(90);
    expect(days).toBeGreaterThan(85);
    const audit = await withOrg(bcba, (tx) =>
      tx.auditEvent.count({ where: { action: "source:uploaded", entityId: doc.id } }),
    );
    expect(audit).toBe(1);
    // The other practice gets the same official copy, and the verification.
    const copies = await withOrg(otherBcba, (tx) =>
      tx.payorDocumentSnapshot.findMany({ where: { document: { key: HANDBOOK } } }),
    );
    expect(copies.map((c) => [c.orgId, c.textSha256, c.origin])).toEqual([
      [other.id, snap.textSha256, "upload"],
    ]);
  });
});

describe("uploads: audit and edition dates", () => {
  const HANDBOOK = "tricare_east_provider_handbook_2026";
  const docByKey = (key: string) =>
    withOrg(bcba, (tx) => tx.payorDocument.findFirstOrThrow({ where: { key } }));
  const count = (action: string, entityId: string) =>
    withOrg(bcba, (tx) => tx.auditEvent.count({ where: { action, entityId } }));

  it("records rejected and unchanged uploads without the file's text", async () => {
    const doc = await docByKey(HANDBOOK);
    const before = await count("source:upload_rejected", doc.id);
    await expect(
      uploadOfficialCopy(curator, doc.id, {
        data: readFileSync("fixtures/payor-docs/synthetic-client-letter.pdf"),
      }),
    ).rejects.toMatchObject({ status: 422 });
    await expect(uploadOfficialCopy(curator, doc.id, { data: Buffer.from("nope") })).rejects.toMatchObject({
      status: 422,
    });
    for (const effectiveDate of ["2026-13-01", "2026-00-10", "2026-02-30"])
      await expect(
        uploadOfficialCopy(curator, doc.id, {
          data: readFileSync("fixtures/payor-docs/synthetic-handbook.pdf"),
          effectiveDate,
        }),
      ).rejects.toMatchObject({ status: 422 });
    expect(await count("source:upload_rejected", doc.id)).toBe(before + 2);
    const rows = await withOrg(bcba, (tx) =>
      tx.auditEvent.findMany({ where: { action: "source:upload_rejected", entityId: doc.id } }),
    );
    for (const r of rows) expect(JSON.stringify(r.meta)).not.toMatch(/Childname|Date of Birth/);
    // The handbook fixture was uploaded earlier in this file: the same file again is recorded as unchanged.
    await uploadOfficialCopy(curator, doc.id, {
      data: readFileSync("fixtures/payor-docs/synthetic-handbook.pdf"),
    });
    expect(await count("source:upload_unchanged", doc.id)).toBeGreaterThanOrEqual(1);
  });

  it("a corrected copy without a date keeps the previous edition date", async () => {
    const doc = await docByKey("humana_aba_faq_xpbb0825");
    const pdf = readFileSync("fixtures/payor-docs/synthetic-handbook.pdf");
    await uploadOfficialCopy(curator, doc.id, { data: pdf, effectiveDate: "2027-01-01" });
    const r = await uploadOfficialCopy(curator, doc.id, {
      data: readFileSync("fixtures/payor-docs/synthetic-handbook-corrected.pdf"),
    });
    expect(r.unchanged).toBe(false);
    const latest = await withOrg(bcba, (tx) =>
      tx.payorDocumentSnapshot.findFirstOrThrow({
        where: { documentId: doc.id },
        orderBy: { fetchedAt: "desc" },
      }),
    );
    expect(latest.effectiveDate?.toISOString().slice(0, 10)).toBe("2027-01-01");
    // This document cites no edition date, so a newer edition is not a "change" against it.
    expect((await docByKey("humana_aba_faq_xpbb0825")).health).toBe("ok");
  });
});

describe("document renames (run last: they change document rows)", () => {
  it("renaming keeps verifications, and reusing the old key does not clash", async () => {
    const channel = async () =>
      (await rulesOf("cigna_evernorth")).find((r) => r.type === "submission_channel")!;
    const before = await channel();
    expect(before.verified).toBe(true);
    const oldDoc = await withOrg(bcba, (tx) =>
      tx.payorDocument.findFirstOrThrow({ where: { key: "evernorth_aba_pa_928213d" } }),
    );
    const renamed = julySeed();
    renamed.documents.evernorth_v2 = {
      ...renamed.documents.evernorth_aba_pa_928213d!,
      formerly: ["evernorth_aba_pa_928213d"],
    };
    delete renamed.documents.evernorth_aba_pa_928213d;
    for (const p of renamed.payors)
      for (const r of [...p.rules, ...p.extra_rules])
        if (r.source === "evernorth_aba_pa_928213d") r.source = "evernorth_v2";
    await withOrg(bcba, (tx) => syncPayorLibrary(tx, org.id, renamed));
    // The rule's lineage includes its source key; its evidence is carried over to the new lineage.
    const after = await channel();
    expect(after.lineageKey).not.toBe(before.lineageKey);
    expect(after.verified).toBe(true);
    expect(after.trust!.verifiedAt).toBe(before.trust!.verifiedAt);
    // A later library that uses the old key again gets a new row instead of a primary-key clash.
    await withOrg(bcba, (tx) => syncPayorLibrary(tx, org.id, julySeed()));
    const reused = await withOrg(bcba, (tx) =>
      tx.payorDocument.findFirstOrThrow({ where: { key: "evernorth_aba_pa_928213d" } }),
    );
    expect(reused.id).not.toBe(oldDoc.id);
  });

  it("a document that loses its public copy stops being watched and can be uploaded", async () => {
    const seed = julySeed();
    seed.documents.aetna_cpb_0648 = { ...seed.documents.aetna_cpb_0648!, url: null, locator: undefined };
    await withOrg(bcba, (tx) => syncPayorLibrary(tx, org.id, seed));
    const doc = await withOrg(bcba, (tx) =>
      tx.payorDocument.findFirstOrThrow({ where: { key: "aetna_cpb_0648" } }),
    );
    expect(doc.locator).toBeNull();
    expect(doc.url).toBeNull();
    // Not 409 ("fetched automatically") any more: the upload is judged on the file.
    await expect(uploadOfficialCopy(curator, doc.id, { data: Buffer.from("x") })).rejects.toMatchObject({
      status: 422,
    });
  });
});
