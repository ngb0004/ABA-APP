import { describe, expect, it } from "vitest";
import { loadGoalBank } from "@/lib/goals/bank";
import { duplicateRationales, requiredCategoryChecks, unresolvedPlaceholders } from "@/lib/goals/checks";
import { suggestGoals } from "@/lib/goals/suggest";

describe("goal bank", () => {
  const bank = loadGoalBank();
  it("parses 18 domains × 3 tiers", () => {
    expect(bank).toHaveLength(54);
    expect(new Set(bank.map((b) => b.domainNumber)).size).toBe(18);
    for (const t of bank) {
      expect(t.goalText).toMatch(/\[(Client|Caregiver)\]/);
      expect(t.rationaleText.length).toBeGreaterThan(50);
      expect(t.goalText).not.toMatch(/REVIEWER FLAG/);
    }
  });
  it("assigns caregiver and behavior-reduction categories", () => {
    expect(bank.filter((b) => b.category === "caregiver")).toHaveLength(3);
    expect(bank.filter((b) => b.category === "behavior_reduction")).toHaveLength(3);
  });
});

describe("placeholders", () => {
  it("treats [Client] as auto-resolved and anything else as unresolved", () => {
    expect(unresolvedPlaceholders("[Client] will mand for [10] items", "baseline [X]%")).toEqual([
      "[10]",
      "[X]",
    ]);
    expect(unresolvedPlaceholders("[Client] will mand for ten items")).toEqual([]);
  });
});

describe("required categories", () => {
  it("requires two caregiver goals and a paired replacement", () => {
    const goals = [
      { id: "a", category: "communication", objective: "", rationale: "" },
      { id: "b", category: "social_play", objective: "", rationale: "" },
      { id: "c", category: "behavior_reduction", objective: "", rationale: "" },
      { id: "d", category: "caregiver", objective: "", rationale: "" },
    ];
    const r = requiredCategoryChecks(goals);
    expect(r.find((x) => x.category === "caregiver")!.ok).toBe(false);
    expect(r.find((x) => x.category === "behavior_reduction")!.ok).toBe(false);
    const fixed = [
      ...goals,
      { id: "e", category: "caregiver", objective: "", rationale: "" },
      { id: "f", category: "replacement", replacementForGoalId: "c", objective: "", rationale: "" },
    ];
    expect(requiredCategoryChecks(fixed).every((x) => x.ok)).toBe(true);
  });
});

describe("duplicate rationale check", () => {
  it("flags near-identical rationale text and ignores distinct text", () => {
    const base =
      "This goal targets independent requesting, the foundational verbal operant through which the learner can access reinforcement directly rather than through problem behavior.";
    const near = base.replace("independent requesting", "independent labeling");
    const other =
      "Expanding the play repertoire allows the learner to stay engaged without adult direction during unstructured time at home and school.";
    const pairs = duplicateRationales([
      { id: "1", category: "x", objective: "", rationale: base },
      { id: "2", category: "x", objective: "", rationale: near },
      { id: "3", category: "x", objective: "", rationale: other },
    ]);
    expect(pairs.map((p) => `${p.a}-${p.b}`)).toEqual(["1-2"]);
  });
});

describe("suggestions", () => {
  it("suggests the lowest domains and next unmastered milestone", () => {
    const scores = [
      { level: 1, domain: "Mand", milestone: 1, score: 1 as const, firstAdmin: 1 },
      { level: 1, domain: "Tact", milestone: 1, score: 1 as const, firstAdmin: 1 },
      { level: 1, domain: "Tact", milestone: 2, score: 1 as const, firstAdmin: 1 },
      { level: 1, domain: "Tact", milestone: 3, score: 0.5 as const, firstAdmin: 1 },
    ];
    const s = suggestGoals(scores, 3);
    expect(s[0]!.level).toBe(1);
    const mand = s.find((x) => x.domain === "Mand");
    const tact = suggestGoals(scores, 20).find((x) => x.domain === "Tact")!;
    expect(tact.nextMilestone).toBe(3);
    expect(mand === undefined || mand.nextMilestone === 2).toBe(true);
  });
});
