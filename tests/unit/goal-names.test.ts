import { describe, expect, it } from "vitest";
import { goalNames, objectiveWords, stableGoalName } from "@/lib/goals/names";

const g = (id: string, domain: string, category: string, objective: string) => ({
  id,
  domain,
  category,
  objective,
});

describe("goal names (goals are never numbered for readers)", () => {
  it("names a goal by its domain", () => {
    const names = goalNames([
      g("a", "Manding (Requesting)", "communication", "[Client] will mand."),
      g("b", "Elopement", "behavior_reduction", "[Client] will stay with an adult."),
    ]);
    expect(names.get("a")).toBe("Manding (Requesting) goal");
    expect(names.get("b")).toBe("Elopement goal");
    for (const n of names.values()) expect(n).not.toMatch(/\d/);
  });

  it("tells goals that share a domain apart by category, then by the objective's first words", () => {
    const names = goalNames([
      g(
        "a",
        "Manding",
        "communication",
        "[Client] will independently mand for a preferred item using [sign].",
      ),
      g(
        "b",
        "Manding",
        "communication",
        "[Client] will independently mand for missing items in 80% of trials.",
      ),
      g("c", "Manding", "replacement", "[Client] will ask for a break."),
    ]);
    expect(names.get("c")).toBe("Manding goal (replacement behavior)");
    expect(names.get("a")).toBe("Manding goal: “independently mand for a preferred…”");
    expect(names.get("b")).toBe("Manding goal: “independently mand for missing items…”");
    for (const n of names.values()) expect(n).not.toMatch(/\d/);
  });

  it("drops value references, bracketed fields, digits, and the opening “will”", () => {
    expect(objectiveWords("[Client] will reach {{goal.2.mastery_pct}} in 80% of [X] trials.")).toEqual([
      "reach",
      "in",
      "of",
      "trials",
    ]);
    expect(objectiveWords("")).toEqual([]);
  });

  it("gives a name from the goal alone that other goals never change", () => {
    const a = g("a", "Manding", "communication", "[Client] will independently mand for a preferred item.");
    expect(stableGoalName(a)).toBe("Manding goal: “independently mand for a preferred item”");
    expect(stableGoalName(g("x", "Tacting", "communication", "{{goal.1.mastery_pct}}"))).toBe("Tacting goal");
  });
});
