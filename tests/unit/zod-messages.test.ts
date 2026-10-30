import { describe, expect, it } from "vitest";
import { z } from "zod";
import { fieldLabel, formatIssues } from "@/lib/server/zod-messages";
import { AuthorizationSchema, NewClientSchema, SessionSchema } from "@/lib/services/records";

const messages = (schema: z.ZodType, input: unknown) => {
  const r = schema.safeParse(input);
  if (r.success) throw new Error("expected a validation error");
  return formatIssues(r.error.issues);
};

describe("validation messages", () => {
  it("turns field names into words", () => {
    expect(fieldLabel("approvedUnits")).toBe("Approved units");
    expect(fieldLabel("icd10Code")).toBe("ICD-10 code");
    expect(fieldLabel("diagnostic_evaluation")).toBe("Diagnostic evaluation");
  });

  it("rewrites Zod's built-in messages as plain sentences, rows numbered from 1", () => {
    const schema = z.object({
      ageYears: z.number().int().min(1).max(21),
      title: z.string().min(1),
      kind: z.enum(["iep", "other"]),
      units: z.array(z.object({ approvedUnits: z.number().int().min(1) })),
    });
    expect(
      messages(schema, {
        ageYears: 4.5,
        title: "",
        kind: "x",
        units: [{ approvedUnits: 5 }, { approvedUnits: 0 }],
      }),
    ).toEqual([
      "Age must be a whole number.",
      "Title is required.",
      "Kind must be one of the listed options.",
      "Approved units (units row 2) must be at least 1.",
    ]);
    expect(messages(schema, { ageYears: null, title: "x", kind: "iep", units: [] })).toEqual([
      "Age is required.",
    ]);
    expect(messages(schema, { ageYears: 25, title: "x", kind: "iep", units: [] })).toEqual([
      "Age must be 21 or less.",
    ]);
  });

  it("keeps the schema's own messages, naming the field only when they do not", () => {
    const auth = {
      payorId: "00000000-0000-4000-8000-000000000000",
      authNumber: "SYN-AUTH-1",
      kind: "initial",
      startDate: "2026-09-01",
      endDate: "2026-08-01",
      units: [],
    };
    const out = messages(AuthorizationSchema, auth);
    expect(out).toContain("Units: Add at least one approved CPT code.");
    expect(out).toContain("End date must be after the start date.");
    expect(
      messages(SessionSchema, {
        authorizationId: auth.payorId,
        cptCode: "97153",
        date: "2026-09-02",
        startMinute: 540,
        units: 60,
        providerRole: "RBT",
        providerId: "RBT-A",
      }),
    ).toEqual(["Units must be 48 or less."]);
  });

  it("never echoes raw paths or Zod wording", () => {
    const out = messages(NewClientSchema, {});
    for (const m of out) {
      expect(m).not.toMatch(/expected|received|Invalid input|\w\.\w+:/);
      expect(m).toMatch(/\.$/);
    }
    expect(out).toContain("First name is required.");
  });
});
