import { afterAll, beforeAll, describe, expect, it } from "vitest";
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
import { syncPayorLibrary } from "@/lib/payors/library";
import { loadPayorSeed } from "@/lib/payors/load";
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
    ).rejects.toThrow(/Missing: 97151, 6/);
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
      verifyRuleWithQuote(bcba, rule.id, { quote: "email it to: ABA@Evernorth.com* (preferred)" }),
    ).rejects.toMatchObject({ status: 409 });
    expect((await rulesOf("cigna_evernorth")).find((r) => r.id === rule.id)!.verified).toBe(false);
    await withOrg(bcba, (tx) => syncPayorLibrary(tx, org.id));
  });

  it("checking sources now is a BCBA action", async () => {
    await expect(checkSourcesNow(ctxAs("RBT"), fakeFetch())).rejects.toMatchObject({ status: 403 });
    expect((await checkSourcesNow(bcba, fakeFetch())).length).toBeGreaterThan(5);
  });
});
