import { describe, expect, it } from "vitest";
import { resetConfirmText, type PlanAssessmentOption } from "@/components/plan-assessments-reset";

const opt = (id: string, o: Partial<PlanAssessmentOption>): PlanAssessmentOption => ({
  id,
  typeName: id,
  administeredOn: "2026-04-12",
  status: "confirmed",
  vbmapp: false,
  selected: false,
  byDefault: false,
  ...o,
});

describe("Reset to default confirmation", () => {
  const options = [
    opt("Vineland-3", { administeredOn: "2026-01-10" }),
    opt("PSI-4", { administeredOn: "2026-09-01", byDefault: true }),
    opt("SRS-2", { status: "draft", administeredOn: null }),
    opt("VB-MAPP", { vbmapp: true, selected: true, byDefault: true }),
  ];

  it("lists what it unchecks and checks, and says approved sections reopen", () => {
    expect(resetConfirmText(options, new Set(["Vineland-3"]))).toBe(
      [
        "Reset to the default selection?",
        "",
        "Unchecks:",
        "- Vineland-3 (2026-01-10)",
        "",
        "Checks:",
        "- PSI-4 (2026-09-01)",
        "",
        "Sections that use assessments, approved ones included, are reopened for a redraft. This cannot be undone.",
      ].join("\n"),
    );
  });

  it("is null when the selection already is the default (VB-MAPP is always used)", () => {
    expect(resetConfirmText(options, new Set(["PSI-4"]))).toBeNull();
  });

  it("does not warn about reopening when only a draft changes", () => {
    const text = resetConfirmText(options, new Set(["PSI-4", "SRS-2"]))!;
    expect(text).toContain("- SRS-2 (no date)");
    expect(text).not.toContain("reopened");
  });
});
