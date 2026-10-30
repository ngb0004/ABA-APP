import { describe, expect, it } from "vitest";
import { REMOVED_GOAL_PLACEHOLDER, goalTokenOrdinals, renumberGoalTokens } from "@/lib/goals/renumber";

describe("renumbering goal tokens after a goal is removed", () => {
  it("moves later goals down one and leaves earlier goals alone", () => {
    expect(
      renumberGoalTokens(
        "{{goal.2.baseline_pct}} then {{goal.4.current_pct}} and {{goal.10.mastery_pct}}",
        3,
      ),
    ).toBe("{{goal.2.baseline_pct}} then {{goal.3.current_pct}} and {{goal.9.mastery_pct}}");
  });
  it("turns references to the removed goal into a bracketed placeholder the BCBA must fill", () => {
    const out = renumberGoalTokens("From {{goal.3.baseline_pct}} to {{ goal.3.current_pct }}.", 3);
    expect(out).toBe(`From ${REMOVED_GOAL_PLACEHOLDER} to ${REMOVED_GOAL_PLACEHOLDER}.`);
    expect(out).not.toMatch(/\{\{/);
  });
  it("never touches goal counts or other keys", () => {
    const t = "{{goals.count.total}} goals; {{client.name}}; {{score.L1.mand.admin2}}";
    expect(renumberGoalTokens(t, 1)).toBe(t);
  });
  it("is a no-op when nothing refers to goals", () => {
    expect(renumberGoalTokens("", 1)).toBe("");
    expect(renumberGoalTokens("plain words", 2)).toBe("plain words");
  });
  it("lists the goal numbers a text refers to", () => {
    expect(goalTokenOrdinals("{{goal.2.a}} {{goal.12.b}} {{goal.2.c}} {{goals.count.total}}")).toEqual([
      2, 12,
    ]);
  });
});
