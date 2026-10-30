import { describe, expect, it } from "vitest";
import { DRAFT_DROPPED_MESSAGE, requestDraft } from "@/components/draft-request";
import { availabilityFacts, vbmappFacts, withUnit } from "@/lib/plan/context";
import { DRAFT_SYSTEM_PROMPT, tidyDraft, valuePrefixesFor } from "@/lib/plan/drafting";
import { SECTION_BY_KEY, SECTIONS } from "@/lib/plan/sections";

describe("draft clean-up", () => {
  it("drops a client possessive or 'the' before the caregiver value", () => {
    expect(tidyDraft("{{client.name}}'s {{caregiver.primary}} attends.")).toBe(
      "{{caregiver.primary}} attends.",
    );
    expect(tidyDraft("{{client.name}}’s {{caregiver.primary}} attends.")).toBe(
      "{{caregiver.primary}} attends.",
    );
    expect(tidyDraft("As reported by the {{caregiver.primary}}.")).toBe(
      "As reported by {{caregiver.primary}}.",
    );
    expect(tidyDraft("The {{caregiver.primary}} practices.")).toBe("{{caregiver.primary}} practices.");
    expect(tidyDraft("the client's {{caregiver.primary}} practices.")).toBe(
      "{{caregiver.primary}} practices.",
    );
    // Other uses are left alone.
    expect(tidyDraft("{{caregiver.primary}}'s schedule and {{client.name}}'s goals.")).toBe(
      "{{caregiver.primary}}'s schedule and {{client.name}}'s goals.",
    );
  });
});

describe("system prompt", () => {
  it("forbids invented content and text addressed to the BCBA, and explains units and the current authorization", () => {
    expect(DRAFT_SYSTEM_PROMPT).toMatch(/Never invent operational definitions/);
    expect(DRAFT_SYSTEM_PROMPT).toMatch(/\[BCBA: add/);
    expect(DRAFT_SYSTEM_PROMPT).toMatch(/never address the BCBA/);
    expect(DRAFT_SYSTEM_PROMPT).toMatch(/do not contradict them/);
    expect(DRAFT_SYSTEM_PROMPT).toMatch(/never call the current authorization's dates the upcoming/);
    expect(DRAFT_SYSTEM_PROMPT).toMatch(/render with their unit/);
  });
});

describe("section value scope", () => {
  it("narrows goal figures to the goals a section covers", () => {
    const red = SECTION_BY_KEY.get("behavior_reduction_goals")!;
    expect(valuePrefixesFor(red, [6, 7])).toEqual(["goal.6.", "goal.7."]);
    const summary = SECTION_BY_KEY.get("goal_summary")!;
    expect(valuePrefixesFor(summary, [1, 2])).toEqual(["goals.", "goal."]);
  });

  it("gives goal figures only to goal sections, and the VB-MAPP scores only to the assessment section", () => {
    const withGoalFigures = SECTIONS.filter((s) => s.valuePrefixes.includes("goal.")).map((s) => s.key);
    expect(withGoalFigures.sort()).toEqual(
      [
        "caregiver_training_goals",
        "goal_summary",
        "group_goals",
        "behavior_reduction_goals",
        "school_plan",
        "skill_acquisition_goals",
      ].sort(),
    );
    for (const s of SECTIONS.filter((x) => x.valuePrefixes.includes("goal.")))
      expect(s.context?.goalFigures, s.key).toBe(true);
    const withScores = SECTIONS.filter((s) => s.valuePrefixes.some((p) => p.startsWith("score."))).map(
      (s) => s.key,
    );
    expect(withScores).toEqual(["assessment_results"]);
  });

  it("gives diagnosis values to the diagnosis, coordination, and medical necessity sections", () => {
    for (const k of ["diagnosis_and_referral", "coordination_of_care", "medical_necessity"])
      expect(SECTION_BY_KEY.get(k)!.valuePrefixes, k).toContain("dx.");
  });

  it("the crisis plan sees aggression values and safety flags", () => {
    const crisis = SECTION_BY_KEY.get("crisis_plan")!;
    expect(crisis.valuePrefixes).toContain("intake.aggression");
    expect(crisis.context?.safetyFlags).toBe(true);
  });
});

describe("values with units", () => {
  it("pluralizes from the rounded value", () => {
    expect(withUnit(1, "hour")).toBe("1 hour");
    expect(withUnit(40, "hour")).toBe("40 hours");
    expect(withUnit(0.5, "hour")).toBe("0.5 hours");
    expect(withUnit(1.04, "minute")).toBe("1 minute");
    expect(withUnit(0, "goal")).toBe("0 goals");
    expect(withUnit(1, "data point")).toBe("1 data point");
  });
});

describe("VB-MAPP facts", () => {
  const levels = { "1": 45, "2": 30, "3": 1.5 };
  const domains = new Map<string, [string, number][]>([
    [
      "1",
      [
        ["Mand", 5],
        ["Tact", 5],
      ],
    ],
    [
      "2",
      [
        ["Mand", 4],
        ["Tact", 2],
        ["Play", 3],
      ],
    ],
    [
      "3",
      [
        ["Mand", 0.5],
        ["Tact", 1],
      ],
    ],
  ]);
  const f = vbmappFacts(levels, domains);

  it("calls a fully met level mastered, not uniform", () => {
    expect(f.level.get("1")).toEqual(["every Level One milestone is met: Level One is mastered"]);
    expect(f.domain.get("1:Mand")).toContain("every Mand milestone at Level One is met");
  });

  it("ranks domains in a level the client has worked through", () => {
    expect(f.domain.get("2:Mand")).toEqual(["highest domain in Level Two"]);
    expect(f.domain.get("2:Tact")).toEqual(["lowest domain in Level Two"]);
    expect(f.domain.get("2:Play")).toEqual([]);
  });

  it("never ranks domains in the emerging level", () => {
    expect(f.level.get("3")![0]).toMatch(/only beginning Level Three/);
    for (const d of ["3:Mand", "3:Tact"]) {
      expect(f.domain.get(d)!.join(" ")).not.toMatch(/lowest|highest/);
      expect(f.domain.get(d)!.join(" ")).toMatch(/do not rank/);
    }
  });

  it("ranks within level one when it is the only level reached", () => {
    const only = vbmappFacts(
      { "1": 6 },
      new Map([
        [
          "1",
          [
            ["Mand", 4],
            ["Tact", 2],
          ],
        ],
      ]),
    );
    expect(only.domain.get("1:Tact")).toEqual(["lowest domain in Level One"]);
    expect(only.level.get("1")).toEqual([]);
  });

  it("facts contain no digits", () => {
    const all = [...f.level.values(), ...f.domain.values()].flat().join(" ");
    expect(all).not.toMatch(/\d/);
  });
});

describe("availability facts", () => {
  it("names available and unavailable days in words", () => {
    const facts = availabilityFacts({
      availability: { value: { Mon: [0, 1], Tue: [2], Wed: [], Thu: [0], Fri: [4], Sat: [] } },
    });
    expect(facts).toEqual([
      "family is available on Mon, Tue, Thu, Fri",
      "family is not available on Wed, Sat",
    ]);
    expect(availabilityFacts({})).toEqual([]);
  });
});

describe("draft request", () => {
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

  it("retries once on a gateway error and returns the retry's answer", async () => {
    const calls: number[] = [];
    const responses = [new Response("Bad Gateway", { status: 502 }), json(200, { text: "ok" })];
    const r = await requestDraft("/x", async () => {
      calls.push(1);
      return responses.shift()!;
    });
    expect(calls).toHaveLength(2);
    expect(r).toEqual({ ok: true, data: { text: "ok" } });
  });

  it("shows a plain message when both attempts time out or drop", async () => {
    let n = 0;
    const r = await requestDraft("/x", async () => {
      n++;
      if (n === 1) return new Response("", { status: 504 });
      throw new TypeError("network error");
    });
    expect(n).toBe(2);
    expect(r).toEqual({ ok: false, data: { error: DRAFT_DROPPED_MESSAGE } });
  });

  it("does not retry an application error", async () => {
    let n = 0;
    const r = await requestDraft("/x", async () => {
      n++;
      return json(422, { error: "AI output failed the numeric firewall twice" });
    });
    expect(n).toBe(1);
    expect(r.ok).toBe(false);
    expect(r.data.error).toMatch(/numeric firewall/);
  });
});
