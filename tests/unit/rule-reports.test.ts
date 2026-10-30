import { describe, expect, it } from "vitest";
import { parseSetCuratorArgs } from "@/lib/auth/curator";
import { REPORT_NOTE_MAX } from "@/lib/payors/report-reasons";
import { looksLikePhiInNote } from "@/lib/rules-watch/text";
import { ReportInput } from "@/lib/services/rule-reports";

describe("rule report notes are checked for client information", () => {
  it("rejects names, dates of birth, and member IDs", () => {
    for (const t of [
      "Denial for my client Jane Doe says 6 months",
      "patient John Smith was denied",
      "Member ID: SYN-0001-AB",
      "member id 12345678 got a denial",
      "subscriber number is 4455667",
      "Child DOB 03/14/2019, letter says annual",
      "born on 2019-03-14",
      "date of birth 3/4/19",
      "their Medicaid number #GA1234567",
      "SSN 123-45-6789",
      "Patient Name: Alpha Testchild",
      "ref 1234567890",
    ])
      expect(looksLikePhiInNote(t), t).toBe(true);
  });

  it("accepts notes about the rule itself", () => {
    for (const t of [
      "",
      "Our denial letter says reassessments are due every 6 months, not 12.",
      "The 2026 handbook moved this to section 803.10; CPT 97153 limit is now 40 hours a week.",
      "The portal says the client Treatment Plan must be signed by the BCBA.",
      "Wrong for self-funded plans in Georgia. The member ID card says ERISA.",
      "Payor rep (reference 2026-10-02) said the PA form changed in October.",
      "Benefits check said no age cap for this plan type.",
    ])
      expect(looksLikePhiInNote(t), t).toBe(false);
  });
});

describe("report input", () => {
  it("needs a known reason and keeps the note under the limit", () => {
    expect(ReportInput.parse({ reason: "outdated" })).toEqual({ reason: "outdated", note: "" });
    expect(() => ReportInput.parse({ reason: "made_up" })).toThrow();
    expect(() => ReportInput.parse({})).toThrow();
    expect(ReportInput.parse({ reason: "other", note: "x".repeat(REPORT_NOTE_MAX) }).note).toHaveLength(
      REPORT_NOTE_MAX,
    );
    expect(() => ReportInput.parse({ reason: "other", note: "x".repeat(REPORT_NOTE_MAX + 1) })).toThrow(
      /under 1000 characters/,
    );
  });
});

describe("set-curator arguments", () => {
  it("takes one email and an optional --revoke", () => {
    expect(parseSetCuratorArgs(["Curator@Yoma-Staff.test"])).toEqual({
      email: "curator@yoma-staff.test",
      grant: true,
    });
    expect(parseSetCuratorArgs(["--revoke", "curator@yoma-staff.test"])).toEqual({
      email: "curator@yoma-staff.test",
      grant: false,
    });
    expect(() => parseSetCuratorArgs([])).toThrow(/Usage/);
    expect(() => parseSetCuratorArgs(["a@b.test", "c@d.test"])).toThrow(/Usage/);
    expect(() => parseSetCuratorArgs(["a@b.test", "--org=x"])).toThrow(/Unknown option/);
    expect(() => parseSetCuratorArgs(["not-an-email"])).toThrow();
  });
});
