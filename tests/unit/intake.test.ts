import { describe, expect, it } from "vitest";
import { applicableFields, INTAKE_FIELDS, validateDraft, validateSubmission } from "@/lib/intake/schema";
import {
  allowedSigners,
  availabilityFit,
  intakeForAi,
  priorEvaluationChecklist,
  safetyFlags,
} from "@/lib/intake/derive";
import { client } from "../helpers/synthetic-eval";

describe("intake schema", () => {
  it("tags every field with a sensitivity and the sections it feeds", () => {
    for (const f of INTAKE_FIELDS) {
      expect(["normal", "sensitive", "restricted"]).toContain(f.sensitivity);
      expect(f.feeds_sections.length).toBeGreaterThan(0);
    }
    const restricted = INTAKE_FIELDS.filter((f) => f.sensitivity === "restricted")
      .map((f) => f.id)
      .sort();
    expect(restricted).toEqual([
      "abuse_history",
      "custody_arrangement",
      "family_psychiatric_history",
      "substance_use",
      "suicidal_behavior",
    ]);
  });

  it("accepts an explicit none / not applicable for any field type", () => {
    const answers = Object.fromEntries(INTAKE_FIELDS.map((f) => [f.id, { na: true }]));
    expect(validateDraft(answers).ok).toBe(true);
    expect(validateSubmission(answers, 14).ok).toBe(true);
  });

  it("rejects blank answers at submission", () => {
    const r = validateSubmission({ primary_concerns: { value: "x" } }, 5);
    expect(r.ok).toBe(false);
    expect(r.issues.find((i) => i.fieldId === "bolting")!.message).toMatch(/none \/ not applicable/);
    expect(
      validateSubmission({ ...client("client1").intake, primary_concerns: { value: "   " } }, 3).ok,
    ).toBe(false);
  });

  it("validates typed answers", () => {
    expect(validateDraft({ sleep_difficulty: { value: "sometimes" } }).ok).toBe(true);
    expect(validateDraft({ sleep_difficulty: { value: "weekly" } }).ok).toBe(false);
    expect(validateDraft({ communication_modes: { value: ["Telepathy"] } }).ok).toBe(false);
    expect(validateDraft({ tantrums: { value: { count: 3, per: "day", durationMinutes: 5 } } }).ok).toBe(
      true,
    );
    expect(validateDraft({ tantrums: { value: { count: -1, per: "day", durationMinutes: 5 } } }).ok).toBe(
      false,
    );
    expect(validateDraft({ diagnosis_date: { value: "03/04/2024" } }).ok).toBe(false);
    expect(validateDraft({ unknown_field: { na: true } }).ok).toBe(false);
  });

  it("asks age-conditional fields only at 12+", () => {
    expect(applicableFields(9).some((f) => f.id === "substance_use")).toBe(false);
    expect(applicableFields(12).some((f) => f.id === "substance_use")).toBe(true);
    // The synthetic intakes (ages 3, 6 and 9) are complete without the 12+ fields.
    for (const [k, age] of [
      ["client1", 3],
      ["client2", 6],
      ["client3", 9],
    ] as const)
      expect(validateSubmission(client(k).intake, age).issues).toEqual([]);
  });
});

describe("restricted fields never reach the AI", () => {
  it("drops restricted fields, names, and numbers-bearing fields from the AI payload", () => {
    const answers = {
      ...client("client2").intake,
      abuse_history: { value: true, comment: "BCBA-only detail" },
      family_psychiatric_history: { value: true, comment: "BCBA-only detail" },
      primary_concerns: { value: "Bravo hits his sister Jordan when tasks are hard." },
    };
    const payload = intakeForAi(answers, {
      client: ["Bravo", "Testchild"],
      others: ["Jordan Testparent", "Jordan"],
    });
    const text = JSON.stringify(payload);
    for (const id of [
      "abuse_history",
      "suicidal_behavior",
      "family_psychiatric_history",
      "custody_arrangement",
    ])
      expect(text).not.toContain(id);
    expect(text).not.toContain("BCBA-only detail");
    expect(text).not.toMatch(/Bravo|Jordan/);
    expect(text).toContain("[Client] hits his sister [Caregiver]");
    expect(payload.bcbaAuthoredRestrictedStatement).toBe(true);
    expect(text).not.toContain("durationMinutes");
  });
});

describe("safety flags", () => {
  it("raises epi-pen and severe allergy for Client 1", () => {
    expect(
      safetyFlags(client("client1").intake)
        .map((f) => f.label)
        .sort(),
    ).toEqual(["Epi-pen", "Severe allergy"]);
  });
  it("raises bolting and transportation risk for Client 3", () => {
    const f = safetyFlags(client("client3").intake);
    expect(f.map((x) => x.label)).toEqual(["Bolting / elopement", "Transportation risk"]);
    expect(f[0]!.detail).toMatch(/street/);
  });
  it("covers inhaler, seizures, overnight wandering, and pica", () => {
    const f = safetyFlags({
      inhaler: { value: true },
      seizures: { value: true },
      overnight_wandering: { value: true },
      pica: { value: true },
      bolting: { value: false },
    });
    expect(f.map((x) => x.label).sort()).toEqual(["Inhaler", "Overnight wandering", "Pica", "Seizures"]);
  });
  it("raises nothing for none / not applicable answers", () => {
    expect(safetyFlags({ bolting: { na: true }, transportation_risks: { na: true } })).toEqual([]);
  });
});

describe("derived intake outputs", () => {
  it("builds the prior-evaluation upload checklist", () => {
    const c3 = client("client3");
    const list = priorEvaluationChecklist(c3.intake, c3.attachments);
    expect(list.map((x) => [x.type, x.uploaded])).toEqual([
      ["Diagnostic evaluation", true],
      ["Speech-language evaluation", false],
    ]);
  });
  it("derives who can sign from custody answers", () => {
    const c3 = client("client3");
    const s = allowedSigners(c3.intake, c3.guardians);
    expect(s.signers.map((g) => g.relationship)).toEqual(["Father"]);
    expect(allowedSigners({}, c3.guardians).signers).toEqual([]);
    const c1 = client("client1");
    expect(allowedSigners(c1.intake, c1.guardians).signers).toHaveLength(2);
  });
  it("compares availability against recommended hours", () => {
    expect(availabilityFit(client("client2").intake, 40)).toEqual({
      available: 50,
      recommended: 40,
      fits: true,
    });
    expect(availabilityFit(client("client3").intake, 25)).toEqual({
      available: 20,
      recommended: 25,
      fits: false,
    });
  });
});
