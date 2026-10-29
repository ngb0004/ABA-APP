import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { nextQuarterStart, parseAetnaCpbDates, parseGaRevisionRecord } from "@/lib/rules-watch/parsers";
import { sectionsOverlap, splitSections } from "@/lib/rules-watch/sections";
import {
  computeTrust,
  relatedChanges,
  type DocState,
  type EvidenceState,
  type SnapshotState,
} from "@/lib/rules-watch/status";
import {
  htmlToText,
  looksLikeClientRecord,
  normalizeText,
  numbersMissingFromQuote,
  quoteAppears,
} from "@/lib/rules-watch/text";

async function gaText() {
  const { extractText, getDocumentProxy } = await import("unpdf");
  const pdf = await getDocumentProxy(
    new Uint8Array(readFileSync("fixtures/payor-docs/ga_asd_manual_2026q4.pdf")),
  );
  return (await extractText(pdf, { mergePages: true })).text;
}

describe("section matching", () => {
  it("splits cited sections and matches at numbering boundaries", () => {
    expect(splitSections("802/803")).toEqual(["802", "803"]);
    expect(sectionsOverlap("802/803", "803.10")).toBe(true);
    expect(sectionsOverlap("Appendix D", "Appendix D")).toBe(true);
    expect(sectionsOverlap("602.3.4", "602.3.3")).toBe(false);
    expect(sectionsOverlap("803", "8031")).toBe(false);
    expect(sectionsOverlap("601.3.1", "601")).toBe(true);
    expect(sectionsOverlap(null, "601")).toBe(false);
    expect(sectionsOverlap("803.4(b)", "803.4")).toBe(true);
    expect(sectionsOverlap("Appendix D", "Appendix B/Appendix C/Appendix D")).toBe(true);
    // An unreadable changed section touches every cited section.
    expect(sectionsOverlap("602.3.4", null)).toBe(true);
  });
});

describe("text and quotes", () => {
  it("normalizes spacing, quotes, and dashes; matches quotes case-insensitively", () => {
    expect(normalizeText("a “b”\n–  c")).toBe('a "b" - c');
    expect(
      quoteAppears("Email it to: ABA@Evernorth.com", "…then EMAIL it   to: ABA@Evernorth.com* (preferred)"),
    ).toBe(true);
    expect(quoteAppears("fax it", "email only")).toBe(false);
  });
  it("requires every number in the rule to appear in the quote", () => {
    const params = { standard_days: 7, expedited_hours: 72, from: "2026-01-01" };
    expect(
      numbersMissingFromQuote(
        params,
        "decisions within 7 calendar days and expedited decisions within 72 hours",
      ),
    ).toEqual([]);
    expect(numbersMissingFromQuote(params, "decisions within 72 hours")).toEqual(["7"]);
    expect(numbersMissingFromQuote({ periods: [13, 26] }, "periods of 13 weeks")).toEqual(["26"]);
    // 7 inside 72 does not count as 7, and 2 is not the 2 in 2.5.
    expect(numbersMissingFromQuote({ d: 7 }, "within 72 hours")).toEqual(["7"]);
    expect(numbersMissingFromQuote({ hours: 2 }, "limited to 2.5 hours")).toEqual(["2"]);
    // Codes inside strings count; ISO dates in strings are skipped.
    expect(
      numbersMissingFromQuote({ code: "97155", from: "2026-01-01" }, "supervision is billed separately"),
    ).toEqual(["97155"]);
    expect(numbersMissingFromQuote({ codes: ["97153", "97155"] }, "97153 and 97155 may not overlap")).toEqual(
      [],
    );
  });
  it("requires a substantial quote", async () => {
    const { quoteIsSubstantial } = await import("@/lib/rules-watch/text");
    expect(quoteIsSubstantial("a             b")).toBe(false);
    expect(quoteIsSubstantial("email it to: ABA@Evernorth.com (preferred)")).toBe(true);
  });
  it("turns HTML into text without scripts and with entities decoded", () => {
    expect(normalizeText(htmlToText("<p>A&amp;B&#39;s</p><script>x()</script><b>c</b>"))).toBe("A&B's c");
  });
});

describe("payor change-log parsers (real documents)", () => {
  it("reads Georgia's Q4 2026 revision record, including the in-person supervision change", async () => {
    const rows = parseGaRevisionRecord(await gaText());
    // The whole table, including "Appendix E, Section B (viii)", "Below 803.11", and MM/YYYY rows.
    expect(rows.length).toBeGreaterThanOrEqual(90);
    expect(rows).toContainEqual({
      date: "2026-04-01",
      section: "Appendix E",
      description: "Updated the PA TAT from 45 days to 7 days",
      change: "M",
    });
    expect(rows).toContainEqual({
      date: "2026-07-01",
      section: "803.11",
      description: "Added new guidance related to treatment requests over 30 hours/week",
      change: "A",
    });
    expect(rows.find((r) => r.date === "2024-10-01" && /Consolidated/.test(r.description))!.section).toBe(
      "Appendix B/Appendix C/Appendix D",
    );
    expect(rows.some((r) => r.date === "2026-01-01" && r.section === "Appendix F")).toBe(true); // "1/1/20206" typo
    expect(rows.filter((r) => r.section === null).length).toBeLessThanOrEqual(2);
    const q4 = rows.filter((r) => r.date === "2026-10-01");
    expect(q4).toHaveLength(16);
    expect(q4).toContainEqual({
      date: "2026-10-01",
      section: "601.3.1",
      description: "Add a provision related to in-person supervision",
      change: "A",
    });
    expect(q4.some((r) => r.section === "Appendix F" && /Treatment Plan Template/.test(r.description))).toBe(
      true,
    );
    expect(rows.some((r) => r.date < "2026-07-01")).toBe(true);
  });
  it("computes Georgia's next quarterly revision", () => {
    expect(nextQuarterStart("2026-10-01")).toBe("2027-01-01");
    expect(nextQuarterStart("2026-07-01")).toBe("2026-10-01");
    expect(nextQuarterStart("2026-02-15")).toBe("2026-04-01");
  });
  it("reads Aetna's Last Review and Next Review dates", () => {
    expect(
      parseAetnaCpbDates(htmlToText(readFileSync("fixtures/payor-docs/aetna_cpb_0648.html", "utf8"))),
    ).toEqual({ lastReview: "2026-10-20", nextReview: "2027-07-08" });
  });
});

describe("trust status", () => {
  const doc: DocState = {
    name: "GA manual",
    secondary: false,
    citedEffectiveDate: "2026-07-01",
    health: "changed",
    lastError: null,
    lastCheckedAt: "2026-10-28T06:00:00Z",
  };
  const snap: SnapshotState = {
    id: "s2",
    textSha256: "new",
    effectiveDate: "2026-10-01",
    versionLabel: "Effective 2026-10-01",
    nextRevision: "2027-01-01",
    revisions: [
      {
        date: "2026-10-01",
        section: "803.10",
        description: "Added Skill Acquisition submission guidance",
        change: "A",
      },
      { date: "2026-01-01", section: "Appendix E", description: "Older change", change: "M" },
    ],
  };
  const verify = (over: Partial<EvidenceState> = {}): EvidenceState => ({
    kind: "verify",
    tier: "T1",
    createdAt: "2026-10-15T12:00:00Z",
    reviewerId: "u",
    snapshotId: "s2",
    textSha256: "new",
    snapshotEffectiveDate: "2026-10-01",
    quote: "q",
    section: "803",
    ...over,
  });
  const today = "2026-10-29";

  it("unsourced, secondary, and unchecked official sources", () => {
    expect(computeTrust({ section: null, doc: null, latest: null, evidence: [], today }).status).toBe(
      "unsourced",
    );
    const sec = computeTrust({
      section: null,
      doc: { ...doc, secondary: true },
      latest: null,
      evidence: [],
      today,
    });
    expect(sec).toMatchObject({ status: "unverified", tier: "T5" });
    expect(
      computeTrust({
        section: "802",
        doc: { ...doc, health: "ok", citedEffectiveDate: "2026-10-01" },
        latest: snap,
        evidence: [],
        today,
      }).status,
    ).toBe("unverified");
  });

  it("is stale when the cited section changed after the cited version, with the payor's description", () => {
    const t = computeTrust({ section: "802/803", doc, latest: snap, evidence: [], today });
    expect(t.status).toBe("stale");
    expect(t.reasons[0]).toBe(
      "Section 803.10 changed 2026-10-01: Added Skill Acquisition submission guidance",
    );
  });

  it("is not stale when the new version's change log lists nothing for the cited section", () => {
    const t = computeTrust({ section: "Appendix E", doc, latest: snap, evidence: [], today });
    expect(t.status).toBe("unverified");
    expect(t.reasons.join(" ")).toMatch(/lists nothing for section Appendix E/);
  });

  it("is stale when a broken source was never fetched", () => {
    expect(
      computeTrust({
        section: "x",
        doc: { ...doc, health: "broken", lastError: "HTTP 404" },
        latest: null,
        evidence: [],
        today,
      }).reasons[0],
    ).toMatch(/unreachable \(HTTP 404\)/);
  });

  it("verified with T1 evidence against the current version, until the next revision or 180 days", () => {
    const t = computeTrust({ section: "803", doc, latest: snap, evidence: [verify()], today });
    expect(t).toMatchObject({ status: "verified", tier: "T1", verifiedUntil: "2027-01-01" });
    expect(
      computeTrust({
        section: "803",
        doc,
        latest: { ...snap, nextRevision: null },
        evidence: [verify()],
        today,
      }).verifiedUntil,
    ).toBe("2027-04-13");
  });

  it("an uploaded (unwatched) document: no watcher clock, verification capped at 90 days", () => {
    const uploaded: DocState = {
      ...doc,
      health: "ok",
      lastCheckedAt: "2026-06-01T00:00:00Z",
      watched: false,
    };
    const plain = { ...snap, nextRevision: null, revisions: [] };
    const t = computeTrust({
      section: "803",
      doc: uploaded,
      latest: plain,
      evidence: [verify()],
      today,
    });
    expect(t.status).toBe("verified");
    expect(t.verifiedUntil).toBe("2027-01-13");
    expect(
      computeTrust({
        section: "803",
        doc: uploaded,
        latest: plain,
        evidence: [verify()],
        today: "2027-01-13",
      }).status,
    ).toBe("stale");
    // A watched document that has not been checked for weeks is not trusted.
    expect(
      computeTrust({
        section: "803",
        doc: { ...uploaded, watched: true },
        latest: plain,
        evidence: [verify()],
        today,
      }).status,
    ).toBe("stale");
    expect(
      computeTrust({ section: "803", doc: uploaded, latest: null, evidence: [], today }).reasons[0],
    ).toMatch(/upload it/);
  });
  it("expires, and a later revoke cancels a verification", () => {
    expect(
      computeTrust({ section: "803", doc, latest: snap, evidence: [verify()], today: "2027-01-02" }).status,
    ).toBe("stale");
    const revoked = computeTrust({
      section: "803",
      doc,
      latest: snap,
      evidence: [verify(), { ...verify(), kind: "revoke", createdAt: "2026-10-20T00:00:00Z" }],
      today,
    });
    expect(revoked.status).toBe("stale"); // falls back to the unverified path: 803.10 changed after the cited version
  });

  it("after the document changes: stale if the section changed or the quote vanished, still verified if the quote is unchanged", () => {
    const later: SnapshotState = {
      ...snap,
      id: "s3",
      textSha256: "newer",
      effectiveDate: "2027-01-01",
      revisions: [{ date: "2027-01-01", section: "803.2", description: "Reworded", change: "M" }],
    };
    const old = verify({ textSha256: "new", snapshotEffectiveDate: "2026-10-01" });
    expect(
      computeTrust({ section: "803", doc, latest: later, evidence: [old], quoteStillPresent: true, today })
        .reasons[0],
    ).toMatch(/803.2 changed 2027-01-01/);
    const elsewhere: SnapshotState = {
      ...later,
      revisions: [{ date: "2027-01-01", section: "901", description: "x", change: "M" }],
    };
    expect(
      computeTrust({
        section: "803",
        doc,
        latest: elsewhere,
        evidence: [old],
        quoteStillPresent: true,
        today,
      }).status,
    ).toBe("verified");
    expect(
      computeTrust({
        section: "803",
        doc,
        latest: elsewhere,
        evidence: [old],
        quoteStillPresent: false,
        today,
      }).reasons[0],
    ).toMatch(/no longer appears/);
  });
});

describe("related changes for checklist-only rules", () => {
  const ga = {
    name: "GA manual",
    citedEffectiveDate: "2026-07-01",
    revisions: [
      {
        date: "2026-10-01",
        section: "601.3.1",
        description: "Add a provision related to in-person supervision",
        change: "A",
      },
      {
        date: "2026-10-01",
        section: "601.1",
        description: "Modified to add licensure requirement",
        change: "M",
      },
      { date: "2025-01-01", section: "601.3", description: "Older supervision wording", change: "M" },
    ],
  };
  it("links supervision and credential rules to same-topic changes after the cited version", () => {
    expect(relatedChanges("supervision_ratio", [ga])).toEqual([
      "Related change in GA manual: section 601.3.1 (2026-10-01) Add a provision related to in-person supervision",
    ]);
    expect(relatedChanges("staff_credential", [ga])).toHaveLength(1);
    expect(relatedChanges("daily_cap", [ga])).toEqual([]);
  });
  it("makes a checklist-only rule need re-check when its topic changed officially", () => {
    const t = computeTrust({
      section: null,
      doc: {
        name: "Checklist",
        secondary: true,
        citedEffectiveDate: null,
        health: "unknown",
        lastError: null,
        lastCheckedAt: null,
      },
      latest: null,
      evidence: [],
      relatedChanges: relatedChanges("supervision_ratio", [ga]),
      today: "2026-10-29",
    });
    expect(t).toMatchObject({ status: "stale", tier: "T5" });
    expect(t.reasons[0]).toMatch(/in-person supervision/);
  });
});

describe("client-record screening for uploads", () => {
  it("catches common labels and date formats, and leaves payor prose alone", () => {
    for (const t of [
      "Patient Name: Jane Doe",
      "CLIENT NAME: JANE DOE",
      "Member Name: Jane Doe",
      "DOB: 2019-03-04",
      "Date of Birth: March 4, 2019",
      "Birth date 4 Mar 2019",
      "Member ID: ZZT0000000",
      "Client Name: Jordan Avery",
    ])
      expect(looksLikeClientRecord(t), t).toBe(true);
    for (const t of [
      "The member name and date of birth must appear on every page.",
      "Enter the member ID from the card.",
      "Member Name: ______________",
      // Blank form templates inside payor manuals.
      "Member Name: Member ID: Date of Birth:",
      "PATIENT NAME: DATE OF BIRTH: ____",
      "Member name: Last Name, First",
      "Client Name: Parent Name:",
    ])
      expect(looksLikeClientRecord(t), t).toBe(false);
  });
});
