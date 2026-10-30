import { describe, expect, it } from "vitest";
import { loadPayorSeed, resolvePayorRules, ruleFingerprint } from "@/lib/payors/load";
import { effectivePlanState, evaluateRule, evaluateRules, scopeFindings } from "@/lib/payors/evaluate";
import { SeedSchema, type Rule } from "@/lib/payors/types";
import type { EvalContext } from "@/lib/payors/context";
import { ALL_STATES, groupByState } from "@/lib/payors/groups";
import { client, evalContextFor, fullPlan } from "../helpers/synthetic-eval";

const seed = loadPayorSeed();
const c2 = client("client2");
const base = evalContextFor(c2, fullPlan("reauth"));
const rule = find("cigna_evernorth", "form_address");

function find(k: string, type: string): Rule {
  return resolvePayorRules(seed, k).find((r) => r.type === type)!;
}
const withPlan = (planType: EvalContext["client"]["planType"], planState: string | null = null) => ({
  ...base,
  client: { ...base.client, planType, planState },
});
const scoped = (planTypes: string[]): Rule => ({ ...rule, verified: true, planTypes });
const payor = (states: string[], lineOfBusiness = "commercial"): EvalContext["payor"] => ({
  key: "test_payor",
  name: "Test Payor",
  states,
  lineOfBusiness,
});

describe("seed: payor states and line of business", () => {
  it("scopes every payor to states and a line of business", () => {
    const by = Object.fromEntries(seed.payors.map((p) => [p.id, p]));
    expect(by.ga_medicaid).toMatchObject({ states: ["GA"], line_of_business: "medicaid" });
    expect(by.peach_state).toMatchObject({ states: ["GA"], line_of_business: "medicaid_managed_care" });
    expect(by.amerigroup).toMatchObject({ states: ["GA"], line_of_business: "medicaid_managed_care" });
    expect(by.bcbs_ga_anthem).toMatchObject({ states: ["GA"], line_of_business: "commercial" });
    for (const k of ["aetna", "cigna_evernorth", "umr"])
      expect(by[k]).toMatchObject({ states: [], line_of_business: "commercial" });
    for (const k of ["tricare_east", "tricare_west"])
      expect(by[k]).toMatchObject({ states: [], line_of_business: "tricare" });
  });

  it("rejects unknown states, plan types, and lines of business", () => {
    const doc = (payor: object, rule: object = {}) => ({
      documents: {},
      payors: [
        {
          id: "x",
          name: "X",
          line_of_business: "commercial",
          ...payor,
          rules: [{ type: "daily_cap", params: {}, source: null, verified: false, ...rule }],
        },
      ],
    });
    expect(SeedSchema.safeParse(doc({ states: ["GA", "TX"] })).success).toBe(true);
    expect(SeedSchema.safeParse(doc({ states: ["Georgia"] })).success).toBe(false);
    expect(SeedSchema.safeParse(doc({ states: ["GA", "GA"] })).success).toBe(false);
    expect(SeedSchema.safeParse(doc({ line_of_business: "medicare" })).success).toBe(false);
    expect(SeedSchema.safeParse(doc({ line_of_business: undefined })).success).toBe(false);
    expect(SeedSchema.safeParse(doc({}, { plan_types: ["commercial_fully_insured"] })).success).toBe(true);
    expect(SeedSchema.safeParse(doc({}, { plan_types: ["fully_insured"] })).success).toBe(false);
    // A rule is limited to what a plan can be, never to "unknown".
    expect(SeedSchema.safeParse(doc({}, { plan_types: ["unknown"] })).success).toBe(false);
    expect(SeedSchema.safeParse(doc({}, { plan_types: [] })).success).toBe(false);
  });

  it("keeps the fingerprint when a rule gains plan_types, so its evidence stays attached", () => {
    const r = { type: "daily_cap", params: { hours: 8 }, source: "x", section: "s" };
    expect(ruleFingerprint("p", { ...r, plan_types: ["commercial_fully_insured"] } as typeof r)).toBe(
      ruleFingerprint("p", r),
    );
    const parsed = SeedSchema.parse({
      documents: {},
      payors: [
        {
          id: "p",
          name: "P",
          line_of_business: "commercial",
          rules: [{ ...r, source: null, verified: false, plan_types: ["commercial_fully_insured"] }],
        },
      ],
    });
    const [resolved] = resolvePayorRules(parsed, "p");
    expect(resolved!.planTypes).toEqual(["commercial_fully_insured"]);
    expect(resolved!.lineageKey).toBe(ruleFingerprint("p", { ...r, source: null }));
  });
});

describe("plan_types filter", () => {
  it("skips a rule for a known plan type it excludes, as not applicable", () => {
    const r = evaluateRule(scoped(["commercial_fully_insured"]), withPlan("commercial_self_funded"));
    expect(r.status).toBe("n/a");
    expect(r.rawStatus).toBe("n/a");
    expect(r.message).toMatch(/fully insured/i);
    expect(r.message).toMatch(/self-funded/i);
  });
  it("evaluates a rule normally when the plan type matches, or the rule has no filter", () => {
    expect(
      evaluateRule(scoped(["commercial_fully_insured"]), withPlan("commercial_fully_insured")).status,
    ).toBe("pass");
    expect(evaluateRule(scoped([]), withPlan("medicaid")).status).toBe("pass");
    expect(evaluateRule({ ...rule, verified: true }, withPlan("medicaid")).status).toBe("pass");
  });
  it("keeps the rule when the plan type is unknown, and says why", () => {
    for (const t of ["unknown", "commercial_unknown"] as const) {
      const r = evaluateRule(scoped(["commercial_fully_insured"]), withPlan(t));
      expect(r.status).toBe("pass");
      expect(r.evidence.join(" ")).toMatch(/confirm the plan type/i);
    }
  });
  it("skips a commercial-only rule for commercial_unknown only when no commercial type is listed", () => {
    expect(evaluateRule(scoped(["medicaid", "tricare"]), withPlan("commercial_unknown")).status).toBe("n/a");
    expect(evaluateRule(scoped(["medicaid", "tricare"]), withPlan("unknown")).status).toBe("pass");
  });
});

describe("scope findings", () => {
  const scopedRules = [scoped(["commercial_fully_insured"]), { ...rule, verified: true }];

  it("adds one warning when the plan type is not recorded", () => {
    for (const t of ["unknown", "commercial_unknown"] as const) {
      const f = scopeFindings(scopedRules, { ...withPlan(t), payor: payor([]) });
      const pt = f.filter((x) => x.id === "scope.plan_type");
      expect(pt).toHaveLength(1);
      expect(pt[0]!.status).toBe("warn");
      expect(pt[0]!.message).toBe(
        "Plan type not recorded: confirm whether this plan is fully insured or self-funded",
      );
    }
  });
  it("adds the plan-type warning for a commercial payor even without filtered rules, never for known types", () => {
    expect(scopeFindings([rule], { ...withPlan("unknown"), payor: payor([]) }).map((x) => x.id)).toContain(
      "scope.plan_type",
    );
    expect(scopeFindings([rule], { ...withPlan("unknown"), payor: payor(["GA"], "medicaid") })).toEqual([]);
    expect(scopeFindings(scopedRules, { ...withPlan("commercial_self_funded"), payor: payor([]) })).toEqual(
      [],
    );
  });
  it("warns when the payor's states do not include the plan's state", () => {
    const ctx = { ...withPlan("commercial_fully_insured", "TX"), payor: payor(["GA"]) };
    const f = scopeFindings([rule], ctx);
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({ id: "scope.payor_state", status: "warn" });
    expect(f[0]!.message).toContain("TX");
    expect(f[0]!.message).toContain("GA");
  });
  it("uses the client's service state when the plan state is not recorded", () => {
    const ga = { ...withPlan("medicaid", null), payor: payor(["GA"], "medicaid") };
    expect(effectivePlanState(ga)).toBe("GA");
    expect(scopeFindings([rule], ga)).toEqual([]);
    const tx = { ...ga, client: { ...ga.client, serviceState: "TX" } };
    expect(scopeFindings([rule], tx).map((x) => x.id)).toEqual(["scope.payor_state"]);
  });
  it("never warns about the state for a nationwide payor", () => {
    expect(scopeFindings([rule], { ...withPlan("tricare", "WA"), payor: payor([], "tricare") })).toEqual([]);
  });
  it("findings are warnings only, never failures", () => {
    const all = scopeFindings(scopedRules, { ...withPlan("unknown", "TX"), payor: payor(["GA"]) });
    expect(all.map((x) => x.id).sort()).toEqual(["scope.payor_state", "scope.plan_type"]);
    for (const f of all) expect(f.status).toBe("warn");
  });
  it("the evaluator itself never fails a seeded payor because of scope", () => {
    for (const r of evaluateRules(resolvePayorRules(seed, "bcbs_ga_anthem"), withPlan("unknown", "TX")))
      expect(["warn", "n/a"]).toContain(r.status);
  });
});

describe("payor groups by state", () => {
  const ps = [
    { key: "ga_medicaid", states: ["GA"] },
    { key: "tx_medicaid", states: ["TX"] },
    { key: "two_state", states: ["GA", "AL"] },
    { key: "tricare_east", states: [] },
  ];
  it("shows the states served and All states by default, and counts the hidden ones", () => {
    const { groups, hiddenStates } = groupByState(ps, ["GA"], false);
    expect(groups.map((g) => [g.label, g.payors.map((p) => p.key)])).toEqual([
      ["Georgia", ["ga_medicaid", "two_state"]],
      ["All states", ["tricare_east"]],
    ]);
    expect(hiddenStates).toEqual(["AL", "TX"]);
  });
  it("shows every state on request, and keeps served states with no payors as empty groups", () => {
    const { groups, hiddenStates } = groupByState(ps, ["GA", "SC"], true);
    expect(groups.map((g) => g.key)).toEqual(["GA", "SC", ALL_STATES, "AL", "TX"]);
    expect(groups.find((g) => g.key === "SC")!.payors).toEqual([]);
    expect(hiddenStates).toEqual([]);
  });
});
