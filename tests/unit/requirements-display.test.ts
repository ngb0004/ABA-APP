import { describe, expect, it } from "vitest";
import { REQUIREMENT_STATUS_LABELS, RULE_TYPE_LABELS } from "@/components/payor-display";
import {
  benefitsCheckFromEligibility,
  eligibilityProvider,
  EligibilityNotConfiguredError,
} from "@/lib/eligibility/provider";
import { RULE_CATEGORIES, requirementStatus, ruleCategory } from "@/lib/payors/categories";
import { RULE_TYPES } from "@/lib/payors/types";
import { BenefitsCheckSchema } from "@/lib/services/records";

describe("requirement topics", () => {
  it("puts every rule type under exactly one topic, with a plain-words label", () => {
    for (const t of RULE_TYPES) {
      expect(RULE_CATEGORIES.filter((c) => c.types.includes(t))).toHaveLength(1);
      expect(ruleCategory(t)).not.toBe("other");
      expect(RULE_TYPE_LABELS[t]).toMatch(/^[A-Z]/);
    }
    expect(ruleCategory("something_new")).toBe("other");
  });

  it("maps the evaluator's raw result to a status for this client", () => {
    expect(requirementStatus("pass")).toBe("met");
    expect(requirementStatus("fail")).toBe("missing");
    expect(requirementStatus("warn")).toBe("manual");
    expect(requirementStatus("n/a")).toBe("n/a");
    expect(REQUIREMENT_STATUS_LABELS[requirementStatus("warn")]).toBe("manual check");
    expect(REQUIREMENT_STATUS_LABELS["n/a"]).toBe("not applicable");
  });
});

describe("eligibility provider stub", () => {
  it("is not configured by default and refuses every request", async () => {
    const p = eligibilityProvider();
    expect(p.configured).toBe(false);
    await expect(
      p.check({
        payerId: "SYN-PAYER",
        providerNpi: "SYN-NPI-0000000000",
        memberId: "SYN-CIG-000202",
        subscriber: { firstName: "Alpha", lastName: "Testchild", dob: "2021-01-01" },
        serviceDate: "2026-10-30",
      }),
    ).rejects.toBeInstanceOf(EligibilityNotConfiguredError);
  });

  it("maps a 271 into a valid benefits check that leaves the ABA specifics to a person", () => {
    const input = benefitsCheckFromEligibility(
      {
        active: true,
        planName: "Example PPO",
        groupNumber: "G1",
        coverageStart: "2026-01-01",
        coverageEnd: null,
        planFunding: "self_funded",
        traceNumber: "123",
      },
      "2026-10-01",
    );
    const v = BenefitsCheckSchema.parse(input);
    expect(v).toMatchObject({
      method: "electronic_eligibility",
      abaCovered: "unknown",
      priorAuthRequired: "unknown",
      planFunding: "self_funded",
      referenceNumber: null,
    });
    expect(v.notes).toBe("Coverage active; plan Example PPO; coverage 2026-01-01 to ?");
    const inactive = benefitsCheckFromEligibility(
      {
        active: false,
        planName: null,
        groupNumber: null,
        coverageStart: null,
        coverageEnd: null,
        planFunding: "unknown",
        traceNumber: null,
      },
      "2026-10-01",
    );
    expect(inactive.abaCovered).toBe("no");
  });
});
