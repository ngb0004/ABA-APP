import { beforeAll, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";
import { withOrg } from "@/lib/db";
import { loadRules } from "@/lib/services/payors";
import {
  checkSourcesNow,
  revokeRuleVerification,
  verifyRuleWithQuote,
  watchAllOrgs,
  watchOrgSources,
} from "@/lib/services/rules-watch";
import { ctxAs, org } from "../helpers/ctx";
import { fakeFetch } from "../helpers/fake-fetch";

const bcba = ctxAs("BCBA");
const rulesOf = (payorKey: string) =>
  withOrg(bcba, async (tx) =>
    loadRules(
      tx,
      (await tx.payor.findUniqueOrThrow({ where: { orgId_key: { orgId: org.id, key: payorKey } } })).id,
    ),
  );

beforeAll(async () => {
  await watchOrgSources(bcba, { fetcher: fakeFetch() });
});

describe("source watcher", () => {
  it("finds the current Georgia manual by title through the index page and records its change log", async () => {
    const doc = await withOrg(bcba, (tx) =>
      tx.payorDocument.findFirstOrThrow({
        where: { key: "ga_medicaid_asd_manual_2026q3" },
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
      tx.payorDocumentSnapshot.count({ where: { document: { key: "ga_medicaid_asd_manual_2026q3" } } }),
    );
    expect(n).toBe(1);
    const aetnaUrl = "https://www.aetna.com/cpb/medical/data/600_699/0648.html";
    const res = await watchOrgSources(bcba, {
      fetcher: fakeFetch({ [aetnaUrl]: { status: 202, body: "" } }),
    });
    expect(res.find((r) => r.key === "aetna_cpb_0648")).toMatchObject({ health: "broken" });
    await watchOrgSources(bcba, { fetcher: fakeFetch() });
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

  it("only a BCBA can verify, the quote must be in the current document, and numbers must appear in it", async () => {
    const rule = (await rulesOf("cigna_evernorth")).find((r) => r.type === "submission_channel")!;
    await expect(
      verifyRuleWithQuote(ctxAs("AUTH_COORDINATOR"), rule.id, { quote: QUOTE }),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      verifyRuleWithQuote(bcba, rule.id, { quote: "submit everything by carrier pigeon to the plan" }),
    ).rejects.toMatchObject({ status: 422 });
    const limit = (await rulesOf("cigna_evernorth")).find((r) => r.type === "unit_limit")!;
    const evernorth = await withOrg(bcba, (tx) =>
      tx.payorDocument.findFirstOrThrow({ where: { key: "evernorth_aba_pa_928213d" } }),
    );
    await expect(
      verifyRuleWithQuote(bcba, limit.id, { quote: QUOTE, documentId: evernorth.id }),
    ).rejects.toThrow(/Missing: 6/);
    // The checklist can never verify a rule.
    const checklist = await withOrg(bcba, (tx) =>
      tx.payorDocument.findFirstOrThrow({ where: { key: "checklist_2026" } }),
    );
    await expect(
      verifyRuleWithQuote(bcba, limit.id, { quote: QUOTE, documentId: checklist.id }),
    ).rejects.toThrow(/secondary source/);
  });

  it("verifies with a real sentence from the Evernorth form, then revokes", async () => {
    const rule = (await rulesOf("cigna_evernorth")).find((r) => r.type === "submission_channel")!;
    await verifyRuleWithQuote(bcba, rule.id, { quote: QUOTE });
    let now = (await rulesOf("cigna_evernorth")).find((r) => r.id === rule.id)!;
    expect(now.trust).toMatchObject({ status: "verified", tier: "T1" });
    expect(now.verified).toBe(true);
    await revokeRuleVerification(bcba, rule.id, "Form revised");
    now = (await rulesOf("cigna_evernorth")).find((r) => r.id === rule.id)!;
    expect(now.trust!.status).toBe("unverified");
    await verifyRuleWithQuote(bcba, rule.id, { quote: QUOTE });
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

  it("checking sources now is a BCBA action", async () => {
    await expect(checkSourcesNow(ctxAs("RBT"), fakeFetch())).rejects.toMatchObject({ status: 403 });
    expect((await checkSourcesNow(bcba, fakeFetch())).length).toBeGreaterThan(5);
  });
});
