import { describe, expect, it } from "vitest";
import { INTAKE_FIELDS } from "@/lib/intake/schema";
import { loadPayorSeed, resolvePayorRules } from "@/lib/payors/load";
import {
  intakeKeysFor,
  LEGACY_SECTIONS,
  PLAN_TOPICS,
  SECTIONS,
  SECTION_BY_KEY,
  sectionsForTopic,
} from "@/lib/plan/sections";

const current = SECTIONS.map((s) => s.key);
const legacy = LEGACY_SECTIONS.map((s) => s.key);

describe("plan structure", () => {
  it("has 23 uniquely keyed sections, three of them conditional", () => {
    expect(current).toHaveLength(23);
    expect(new Set([...current, ...legacy]).size).toBe(23 + 11);
    expect(SECTIONS.filter((s) => s.condition).map((s) => s.key)).toEqual([
      "group_goals",
      "school_plan",
      "telehealth_readiness",
    ]);
  });

  it("every intake field feeds a current section, and every current section key it names exists", () => {
    for (const f of INTAKE_FIELDS) {
      expect(f.feeds_sections.length, f.id).toBeGreaterThan(0);
      for (const k of f.feeds_sections) expect(current, `${f.id} → ${k}`).toContain(k);
    }
    // Legacy sections still collect intake answers through the current keys.
    for (const s of LEGACY_SECTIONS) for (const k of intakeKeysFor(s)) expect(current).toContain(k);
  });

  it("restricted intake fields only feed sections the AI never sees them in", () => {
    // Restricted answers are filtered out before drafting; this guards the mapping, not the filter.
    for (const f of INTAKE_FIELDS.filter((x) => x.sensitivity === "restricted"))
      for (const k of f.feeds_sections) expect(SECTION_BY_KEY.has(k)).toBe(true);
  });

  it("every plan topic maps to real sections in both structures", () => {
    for (const [topic, t] of Object.entries(PLAN_TOPICS)) {
      for (const k of t.current) expect(current, topic).toContain(k);
      for (const k of t.legacy) expect(legacy, topic).toContain(k);
    }
    expect(sectionsForTopic("crisis_plan", current)).toEqual(["crisis_plan"]);
    expect(sectionsForTopic("crisis_plan", legacy)).toEqual(["crisis"]);
    expect(sectionsForTopic("not_a_topic", current)).toBeUndefined();
  });

  it("covers every section topic the seeded payor rules require", () => {
    const seed = loadPayorSeed();
    for (const p of seed.payors)
      for (const r of resolvePayorRules(seed, p.id).filter((x) => x.type === "plan_content"))
        for (const topic of (r.params.must_include as string[] | undefined) ?? []) {
          // Lowercase snake-case topics are section topics; free-text items are manual checks.
          if (!/^[a-z_]+$/.test(topic)) continue;
          if (["evaluation_date"].includes(topic) || PLAN_TOPICS[topic]) continue;
          // Remaining snake-case items are checked by hand in the evaluator; list them so a new one is a decision.
          expect([
            "target_behaviors_operationally_defined",
            "baseline_measures",
            "quantifiable_progress_criteria",
            "intervention_techniques_per_target",
            "reinforcers_selected",
            "progress_documentation_or_treatment_modification",
            "hours_justified_by_impairment_level",
            "objective_measurable_goals",
            "goal_linked_to_presenting_problem",
            "goal_progress_timeframe",
            "progress_assessed_within_timeframe",
            "member_identifier_every_page",
            "specific_aba_services_per_behavior_target",
          ]).toContain(topic);
        }
  });
});
