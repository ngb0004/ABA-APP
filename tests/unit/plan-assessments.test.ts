import { describe, expect, it } from "vitest";
import { assessmentCatalog, parseAssessmentCatalog, toolMatches } from "@/lib/assessments/catalog";
import {
  assessmentsForModel,
  assessmentValues,
  ASSESSMENT_LOOKBACK_MONTHS,
  assessmentWindow,
  assessmentWindowLabel,
  assessmentWindowStart,
  defaultAssessmentSelection,
  redraftMarks,
  sameSelection,
  sectionsUsingAssessments,
  seriesKey,
  seriesNumbers,
  nextSeriesNumber,
  DIRECTION_FACT,
  usedAssessments,
} from "@/lib/assessments/plan";
import { assessmentItem, type StoredAssessment } from "@/lib/assessments/view";
import { SourcedContext, validateAiText, tokensIn } from "@/lib/firewall";
import { suggestFromAreas, tierForShare } from "@/lib/goals/suggest";
import { evaluateRule } from "@/lib/payors/evaluate";
import type { EvalContext } from "@/lib/payors/context";
import type { Rule } from "@/lib/payors/types";
import { assessmentChecks } from "@/lib/plan/presubmission";
import type { PlanBundle } from "@/lib/plan/context";
import { SECTIONS, LEGACY_SECTIONS } from "@/lib/plan/sections";
import { client, evalContextFor, fullPlan } from "../helpers/synthetic-eval";
import YAML from "yaml";
import { readFileSync } from "node:fs";

const catalog = assessmentCatalog();
const CLIENT = "00000000-0000-4000-8000-000000000001";

type Row = StoredAssessment & {
  reviewedAt: Date | null;
  seriesKey?: string | null;
  seriesNumber?: number | null;
};
let seq = 0;
function row(over: Partial<Row> & { typeKey: string; administeredOn: Date }): Row {
  seq++;
  return {
    id: `00000000-0000-4000-8000-${String(seq).padStart(12, "0")}`,
    module: null,
    form: null,
    respondent: null,
    customName: null,
    administeredBy: "AS",
    source: "manual",
    status: "confirmed",
    reviewedAt: new Date("2026-10-01T12:00:00Z"),
    notes: null,
    scores: [],
    ...over,
  };
}
const day = (d: string) => new Date(`${d}T00:00:00Z`);
const score = (scaleKey: string, value: number, possible: number | null = null) => ({
  scaleKey,
  scaleName: null,
  scaleKind: null,
  value,
  possible,
});

const vinelandOld = row({
  typeKey: "vineland_3",
  form: "comprehensive_interview",
  respondent: "parent_caregiver",
  administeredOn: day("2025-04-12"),
  scores: [
    score("abc", 66),
    score("communication", 64),
    score("daily_living", 70),
    score("socialization", 62),
  ],
});
const vinelandNew = row({
  typeKey: "vineland_3",
  form: "comprehensive_interview",
  respondent: "parent_caregiver",
  administeredOn: day("2026-04-12"),
  scores: [
    score("abc", 71),
    score("communication", 69),
    score("daily_living", 76),
    score("socialization", 66),
    score("abc_pct", 3),
    score("receptive", 9),
  ],
});
const ablls = row({
  typeKey: "ablls_r",
  administeredOn: day("2026-10-07"),
  scores: [score("cooperation", 10, 38), score("intraverbals", 0, 108), score("eating", 12, 30)],
});
const draftSrs = row({
  typeKey: "srs_2",
  status: "draft",
  reviewedAt: null,
  administeredOn: day("2026-10-20"),
  scores: [score("total_t", 71)],
});
const other = row({
  typeKey: "other",
  customName: "ADOS-2",
  administeredOn: day("2026-09-01"),
  scores: [
    {
      scaleKey: "custom_module_2_total",
      scaleName: "Module 2 total",
      scaleKind: "raw",
      value: 14,
      possible: null,
    },
  ],
});
const all = [vinelandOld, vinelandNew, ablls, draftSrs, other];

// ---------------------------------------------------------------- selection default

describe("default assessment selection", () => {
  it("starts six months back by default (BCBA answer #42); the authorization start no longer widens it", () => {
    expect(ASSESSMENT_LOOKBACK_MONTHS).toBe(6);
    expect(assessmentWindowStart("2026-10-29")).toBe("2026-04-29");
    expect(assessmentWindowStart("2026-10-29", 3)).toBe("2026-07-29");
    expect(assessmentWindowStart("2026-10-29", 12)).toBe("2025-10-29");
    // Month ends clamp, leap years included.
    expect(assessmentWindowStart("2026-08-31")).toBe("2026-02-28");
    expect(assessmentWindowStart("2028-08-31")).toBe("2028-02-29");
    expect(assessmentWindowStart("2027-05-31", 3)).toBe("2027-02-28");
  });

  const windowRule = (months: unknown, verified = false, extra: Partial<Rule> = {}): Rule =>
    ({
      id: `w${String(months)}`,
      payorKey: "p",
      type: "assessment_window",
      params: { months },
      verified,
      source: {
        key: "doc",
        name: "Example Payor Manual",
        version: "2026",
        section: "4.2 Assessments",
        url: null,
      },
      notes: null,
      inheritedFrom: null,
      ...extra,
    }) as Rule;

  it("uses the primary payor's assessment_window rule when there is one, else six months", () => {
    expect(assessmentWindow([])).toEqual({ months: 6, rule: null });
    const w = assessmentWindow([windowRule(3)]);
    expect(w.months).toBe(3);
    expect(w.rule).toMatchObject({ id: "w3", verified: false, sourceName: "Example Payor Manual" });
    expect(assessmentWindowLabel(w)).toBe(
      "Default window: 3 months, from Example Payor Manual, 4.2 Assessments (unverified)",
    );
    expect(assessmentWindowLabel(assessmentWindow([]))).toBe("Default window: 6 months");
    expect(assessmentWindowLabel(assessmentWindow([windowRule(3, true)]))).toBe(
      "Default window: 3 months, from Example Payor Manual, 4.2 Assessments",
    );
    expect(assessmentWindowLabel(assessmentWindow([windowRule(1, true)]))).toBe(
      "Default window: 1 month, from Example Payor Manual, 4.2 Assessments",
    );
  });

  it("an unverified window still applies (it only selects defaults); the narrowest wins", () => {
    expect(assessmentWindow([windowRule(3, false), windowRule(4, true)]).months).toBe(3);
    // Other rule types and malformed windows are ignored.
    const other = { ...windowRule(2), type: "plan_content" } as Rule;
    expect(
      assessmentWindow([other, windowRule(0), windowRule(2.5), windowRule("3"), windowRule(99)]),
    ).toEqual({
      months: 6,
      rule: null,
    });
    const unsourced = windowRule(3, false, {
      source: { key: null, name: null, version: null, section: null, url: null },
    });
    expect(assessmentWindowLabel(assessmentWindow([unsourced]))).toBe(
      "Default window: 3 months, from a payor rule with no source (unverified)",
    );
  });

  it("selects confirmed assessments in the window only, oldest first", () => {
    const ids = defaultAssessmentSelection(all, "2025-10-29");
    expect(ids).toEqual([vinelandNew.id, other.id, ablls.id]);
    // Drafts are never selected by default; the older Vineland is outside the window.
    expect(ids).not.toContain(draftSrs.id);
    expect(ids).not.toContain(vinelandOld.id);
    expect(defaultAssessmentSelection(all, "2025-01-01")).toContain(vinelandOld.id);
  });

  it("includes an assessment given on the window's first day", () => {
    expect(defaultAssessmentSelection([vinelandOld], "2025-04-12")).toEqual([vinelandOld.id]);
  });

  it("compares selections as sets", () => {
    expect(sameSelection(["a", "b"], ["b", "a"])).toBe(true);
    expect(sameSelection(["a"], ["a", "b"])).toBe(false);
  });
});

// ---------------------------------------------------------------- series and numbering

describe("series keys and numbers", () => {
  it("names a series by type, module, form where compared per form, and the BCBA's name for other", () => {
    expect(seriesKey(catalog, vinelandNew)).toBe("vineland_3");
    expect(
      seriesKey(catalog, { typeKey: "afls", module: "basic_living", form: null, customName: null }),
    ).toBe("afls_basic_living");
    expect(seriesKey(catalog, { typeKey: "pddbi", module: null, form: "parent", customName: null })).toBe(
      "pddbi_parent",
    );
    expect(seriesKey(catalog, other)).toBe("other_ados_2");
  });

  it("a stored number never changes: a back-dated administration confirmed later gets the next one", () => {
    const stored = (r: Row, n: number) => ({ ...r, seriesKey: "vineland_3", seriesNumber: n });
    const a = stored(vinelandOld, 1);
    const b = stored(vinelandNew, 2);
    const older = row({
      typeKey: "vineland_3",
      administeredOn: day("2024-03-01"),
      scores: [score("abc", 60)],
    });
    expect(nextSeriesNumber(catalog, [a, b], older)).toEqual({ series: "vineland_3", n: 3, backfill: [] });
    const n = seriesNumbers(catalog, [a, b, { ...older, seriesKey: "vineland_3", seriesNumber: 3 }]);
    expect(n.get(vinelandOld.id)).toEqual({ series: "vineland_3", n: 1 });
    expect(n.get(vinelandNew.id)).toEqual({ series: "vineland_3", n: 2 });
    expect(n.get(older.id)).toEqual({ series: "vineland_3", n: 3 });
  });

  it("rows confirmed before numbers were stored keep their date order, and are stored on the next confirm", () => {
    const older = row({
      typeKey: "vineland_3",
      administeredOn: day("2024-03-01"),
      scores: [score("abc", 60)],
    });
    expect(nextSeriesNumber(catalog, all, older)).toEqual({
      series: "vineland_3",
      n: 3,
      backfill: [
        { id: vinelandOld.id, series: "vineland_3", n: 1 },
        { id: vinelandNew.id, series: "vineland_3", n: 2 },
        { id: other.id, series: "other_ados_2", n: 1 },
        { id: ablls.id, series: "ablls_r", n: 1 },
      ],
    });
  });

  it("'previous administration' facts follow dates, not token numbers", () => {
    const later = { ...vinelandOld, seriesKey: "vineland_3", seriesNumber: 2 };
    const earlier = { ...vinelandNew, seriesKey: "vineland_3", seriesNumber: 1 };
    // Token 1 is the newer administration here; its previous one is token 2.
    const ctx = new SourcedContext(
      assessmentValues(catalog, CLIENT, [later, earlier], [later.id, earlier.id]),
    );
    expect(ctx.get("assessment.vineland_3.1.abc")!.facts).toContain(
      "higher than at the previous selected administration ({{assessment.vineland_3.2.date}})",
    );
    expect(ctx.get("assessment.vineland_3.2.abc")!.facts!.join(" ")).not.toMatch(/previous/);
  });

  it("numbers confirmed administrations oldest first, whether or not they are selected", () => {
    const n = seriesNumbers(catalog, all);
    expect(n.get(vinelandOld.id)).toEqual({ series: "vineland_3", n: 1 });
    expect(n.get(vinelandNew.id)).toEqual({ series: "vineland_3", n: 2 });
    expect(n.has(draftSrs.id)).toBe(false);
  });
});

// ---------------------------------------------------------------- tokens and the firewall

describe("assessment tokens", () => {
  const values = assessmentValues(catalog, CLIENT, all, [vinelandNew.id, ablls.id, draftSrs.id, other.id]);
  const ctx = new SourcedContext(values);
  const v = (k: string) => ctx.get(k)!;

  it("adds name, date, administered by, form, respondent, and every score, with source links", () => {
    expect(v("assessment.vineland_3.2.name").display).toBe("Vineland-3");
    expect(v("assessment.vineland_3.2.date").display).toBe("04/12/2026");
    expect(v("assessment.vineland_3.2.administered_by").display).toBe("AS");
    expect(v("assessment.vineland_3.2.form").display).toBe("Comprehensive Interview Form");
    expect(v("assessment.vineland_3.2.respondent").display).toBe("Parent or caregiver");
    expect(v("assessment.vineland_3.2.abc").value).toBe(71);
    expect(v("assessment.vineland_3.2.abc").display).toBe("71");
    expect(v("assessment.vineland_3.2.abc").label).toMatch(/Adaptive Behavior Composite, standard score/);
    expect(v("assessment.vineland_3.2.abc_pct").display).toBe("3rd percentile");
    expect(v("assessment.vineland_3.2.receptive").label).toMatch(/part of Communication/);
    expect(v("assessment.vineland_3.2.abc").source).toMatchObject({
      kind: "assessment",
      id: vinelandNew.id,
      field: "scores.abc.value",
      href: `/clients/${CLIENT}/assessments#assessment-${vinelandNew.id}`,
    });
  });

  it("adds possible points, and a skills total computed from the stored areas", () => {
    expect(v("assessment.ablls_r.1.intraverbals").display).toBe("0");
    expect(v("assessment.ablls_r.1.intraverbals.possible").display).toBe("108");
    expect(v("assessment.ablls_r.1.total").value).toBe(22);
    expect(v("assessment.ablls_r.1.total.possible").value).toBe(176);
    expect(v("assessment.ablls_r.1.total").source.description).toMatch(
      /computed from the stored area scores/,
    );
  });

  it("leaves out unselected assessments and selected drafts (as for unverified VB-MAPP)", () => {
    expect(ctx.keys().some((k) => k.startsWith("assessment.vineland_3.1."))).toBe(false);
    expect(ctx.keys().some((k) => k.startsWith("assessment.srs_2."))).toBe(false);
  });

  it("names a scale typed with digits by its own token", () => {
    expect(v("assessment.other_ados_2.1.name").display).toBe("ADOS-2");
    expect(v("assessment.other_ados_2.1.custom_module_2_total.name").display).toBe("Module 2 total");
  });

  it("labels and facts carry no digits outside tokens, so the model has none to copy", () => {
    for (const x of values) {
      const outside = (s: string) => s.replace(/\{\{[^}]+\}\}/g, " ");
      expect(outside(x.label), x.key).not.toMatch(/\d/);
      for (const f of x.facts ?? []) expect(outside(f), x.key).not.toMatch(/\d/);
      for (const t of [...tokensIn(x.label), ...(x.facts ?? []).flatMap(tokensIn)])
        expect(ctx.has(t), `${x.key} refers to ${t}`).toBe(true);
    }
  });

  it("gives qualitative facts: lowest and highest area by share, lowest and highest domain", () => {
    expect(v("assessment.ablls_r.1.intraverbals").facts).toContain(
      "lowest area of this assessment by share of possible points",
    );
    expect(v("assessment.ablls_r.1.eating").facts).toContain(
      "highest area of this assessment by share of possible points",
    );
    expect(v("assessment.vineland_3.2.socialization").facts).toContain(
      "lowest standard score among this assessment's main domains, where a higher score means stronger skills: the area of greatest need among them",
    );
    // The composite is not ranked with the domains it summarizes.
    expect(v("assessment.vineland_3.2.abc").facts!.join(" ")).not.toMatch(/lowest|highest/);
    expect(v("assessment.vineland_3.2.abc").facts).toContain(DIRECTION_FACT.better);
  });

  it("ranks only scales of the same direction; indexes and composites are never ranked", () => {
    // The maladaptive index (v-scale, higher means more concern) is never the "lowest domain".
    const vin = row({
      typeKey: "vineland_3",
      administeredOn: day("2026-05-01"),
      scores: [
        score("abc", 71),
        score("communication", 69),
        score("daily_living", 76),
        score("socialization", 66),
        score("maladaptive_index", 18),
        score("internalizing", 17),
      ],
    });
    const vc = new SourcedContext(assessmentValues(catalog, CLIENT, [vin], [vin.id]));
    expect(vc.get("assessment.vineland_3.1.socialization")!.facts!.join(" ")).toMatch(
      /lowest.*greatest need/,
    );
    expect(vc.get("assessment.vineland_3.1.maladaptive_index")!.facts).toEqual([DIRECTION_FACT.worse]);
    // A sub-scale takes its parent's direction.
    expect(vc.get("assessment.vineland_3.1.internalizing")!.facts).toEqual([DIRECTION_FACT.worse]);
    // PDDBI (Charlie's parent form): problem and approach domains are never ranked together.
    const pddbi = row({
      typeKey: "pddbi",
      form: "parent",
      administeredOn: day("2026-04-13"),
      scores: [
        score("autism_composite", 63),
        score("ritualisms", 66),
        score("social_approach", 38),
        score("expressive_language", 41),
      ],
    });
    const pc = new SourcedContext(assessmentValues(catalog, CLIENT, [pddbi], [pddbi.id]));
    const f = (k: string) => pc.get(`assessment.pddbi_parent.1.${k}`)!.facts ?? [];
    expect(f("social_approach")).toEqual([DIRECTION_FACT.better]);
    expect(f("ritualisms")).toEqual([DIRECTION_FACT.worse]);
    expect(f("autism_composite")).toEqual([DIRECTION_FACT.worse]);
    // With three problem domains they are ranked by concern.
    const more = row({
      typeKey: "pddbi",
      form: "teacher",
      administeredOn: day("2026-04-14"),
      scores: [score("ritualisms", 66), score("aggressiveness", 52), score("specific_fears", 58)],
    });
    const mc = new SourcedContext(assessmentValues(catalog, CLIENT, [more], [more.id]));
    expect(mc.get("assessment.pddbi_teacher.1.ritualisms")!.facts).toContain(
      "highest T-score among this assessment's main problem scales, where a higher score means more concern: the area of greatest concern among them",
    );
    expect(mc.get("assessment.pddbi_teacher.1.aggressiveness")!.facts!.join(" ")).toMatch(/least concern/);
  });

  it("says higher or lower than the previous selected administration", () => {
    const both = new SourcedContext(assessmentValues(catalog, CLIENT, all, [vinelandOld.id, vinelandNew.id]));
    expect(both.get("assessment.vineland_3.2.abc")!.facts).toContain(
      "higher than at the previous selected administration ({{assessment.vineland_3.1.date}})",
    );
    expect(both.get("assessment.vineland_3.1.abc")!.facts ?? []).not.toContainEqual(
      expect.stringMatching(/previous/),
    );
  });

  it("passes the firewall when AI text uses the tokens, and fails on raw digits", () => {
    const ok = validateAiText(
      "On {{assessment.vineland_3.2.date}}, {{assessment.vineland_3.2.name}} placed the Adaptive Behavior Composite at {{assessment.vineland_3.2.abc}}, at the {{assessment.vineland_3.2.abc_pct}}.",
      ctx,
    );
    expect(ok.ok).toBe(true);
    expect(validateAiText("The Vineland-3 composite was {{assessment.vineland_3.2.abc}}.", ctx).ok).toBe(
      false,
    );
    expect(validateAiText("The composite was 71.", ctx).ok).toBe(false);
    expect(validateAiText("{{assessment.vineland_3.1.abc}} earlier.", ctx).errors[0]!.kind).toBe(
      "unknown_key",
    );
  });

  it("keeps VB-MAPP keys out of the assessment namespace", () => {
    expect(values.every((x) => x.key.startsWith("assessment."))).toBe(true);
  });
});

describe("what the drafting model sees about assessments", () => {
  const selected = [vinelandNew.id, ablls.id, other.id];
  const values = assessmentValues(catalog, CLIENT, all, selected);
  const used = usedAssessments(catalog, CLIENT, all, selected);
  const payload = assessmentsForModel(used, values);
  const json = JSON.stringify(payload);

  it("lists names and tokens, never values, notes, or digits outside tokens", () => {
    expect(payload).toHaveLength(3);
    expect(payload[0]!.name).toBe("{{assessment.vineland_3.2.name}}");
    expect(payload[0]!.form).toBe("Comprehensive Interview Form");
    expect(payload[0]!.scores.find((s) => s.scale === "Adaptive Behavior Composite")!.token).toBe(
      "{{assessment.vineland_3.2.abc}}",
    );
    expect(json).not.toMatch(/"value"\s*:/);
    expect(json.replace(/\{\{[^}]+\}\}/g, "")).not.toMatch(/\d/);
    expect(json).not.toContain("notes");
    const ctx = new SourcedContext(values);
    for (const t of tokensIn(json)) expect(ctx.has(t), t).toBe(true);
  });

  it("includes possible points and the total for skills assessments", () => {
    const a = payload.find((p) => p.name.includes("ablls_r"))!;
    expect(a.total).toEqual({
      token: "{{assessment.ablls_r.1.total}}",
      possible: "{{assessment.ablls_r.1.total.possible}}",
    });
    expect(a.scores.find((s) => s.scale === "Intraverbals")!.possible).toBe(
      "{{assessment.ablls_r.1.intraverbals.possible}}",
    );
  });
});

// ---------------------------------------------------------------- redraft marking

describe("redraft marking after the selection changes", () => {
  it("only the assessment sections draw on the selected assessments", () => {
    expect(sectionsUsingAssessments(SECTIONS.map((s) => s.key))).toEqual(["assessment_results"]);
    expect(sectionsUsingAssessments(LEGACY_SECTIONS.map((s) => s.key))).toEqual(["assessment"]);
  });

  const sec = (key: string, state: string, content: string, aiDraft: string | null = content) => ({
    key,
    state,
    content,
    aiDraft,
  });

  it("flags drafted and edited sections, reopens approved ones, and never approves", () => {
    expect(redraftMarks([sec("assessment_results", "draft", "Text")])).toEqual([
      { key: "assessment_results", state: "draft", reopened: false },
    ]);
    expect(redraftMarks([sec("assessment_results", "edited", "Mine", "AI")])).toEqual([
      { key: "assessment_results", state: "edited", reopened: false },
    ]);
    expect(redraftMarks([sec("assessment_results", "approved", "Text")])).toEqual([
      { key: "assessment_results", state: "draft", reopened: true },
    ]);
    expect(redraftMarks([sec("assessment_results", "approved", "Mine", "AI")])).toEqual([
      { key: "assessment_results", state: "edited", reopened: true },
    ]);
    const marks = redraftMarks([
      sec("assessment_results", "approved", "Text"),
      sec("crisis_plan", "approved", "Text"),
    ]);
    expect(marks.every((m) => m.state !== "approved")).toBe(true);
  });

  it("leaves empty, not-applicable, and unrelated sections alone", () => {
    expect(redraftMarks([sec("assessment_results", "draft", "  ", null)])).toEqual([]);
    expect(redraftMarks([sec("assessment_results", "not_applicable", "Text")])).toEqual([]);
    expect(redraftMarks([sec("medical_necessity", "approved", "Text")])).toEqual([]);
  });

  it("also flags any other section whose text cites an assessment token", () => {
    expect(
      redraftMarks([sec("medical_necessity", "approved", "ABC was {{assessment.vineland_3.1.abc}}.")]),
    ).toEqual([{ key: "medical_necessity", state: "draft", reopened: true }]);
  });
});

// ---------------------------------------------------------------- payor rule tool names

describe("payor rule tool names to catalog tools (catalog payor_names)", () => {
  it("maps whole names, form-specific names, and 'or' alternatives", () => {
    expect(toolMatches(catalog, "Vineland-3")).toEqual([{ typeKey: "vineland_3", form: null }]);
    expect(toolMatches(catalog, "SRS-2")).toEqual([{ typeKey: "srs_2", form: null }]);
    expect(toolMatches(catalog, "PDDBI")).toEqual([{ typeKey: "pddbi", form: null }]);
    expect(toolMatches(catalog, "PDDBI_parent")).toEqual([{ typeKey: "pddbi", form: "parent" }]);
    expect(toolMatches(catalog, "PDDBI_teacher_or_BCBA")).toEqual([{ typeKey: "pddbi", form: "teacher" }]);
    expect(toolMatches(catalog, "PSI or SIPA")).toEqual([
      { typeKey: "psi_4", form: null },
      { typeKey: "sipa", form: null },
    ]);
    expect(toolMatches(catalog, "PSI (age 0-12) or SIPA (age 11-19)")).toEqual([
      { typeKey: "psi_4", form: null },
      { typeKey: "sipa", form: null },
    ]);
  });

  it("returns null for tools the catalog does not hold", () => {
    expect(toolMatches(catalog, "ADOS-2")).toBeNull();
    expect(toolMatches(catalog, "two_year_review")).toBeNull();
  });

  it("covers every outcome measure the seeded payor rules name, except free-text reviews", () => {
    const seed = YAML.parse(readFileSync("seed/payors.yaml", "utf8"), { merge: true }) as {
      payors: { rules?: { type: string; params: Record<string, unknown> }[] }[];
    };
    const names = new Set<string>();
    for (const p of seed.payors)
      for (const r of p.rules ?? [])
        if (r.type === "outcome_measure_schedule")
          for (const k of ["initial", "every_6_months", "annually", "every_2_years"])
            for (const m of (r.params[k] as string[] | undefined) ?? []) names.add(m);
    expect(names.size).toBeGreaterThan(3);
    for (const n of names) if (!/review/i.test(n)) expect(toolMatches(catalog, n), n).not.toBeNull();
  });

  it("rejects a payor name that would mean two tools", () => {
    const doc = YAML.parse(readFileSync("seed/assessments.yaml", "utf8"), { merge: true });
    doc.assessments.find((t: { key: string }) => t.key === "srs_2").payor_names = ["Vineland-3"];
    expect(() => parseAssessmentCatalog(doc)).toThrow(/payor name "Vineland-3" names both/);
  });
});

// ---------------------------------------------------------------- outcome cadence from assessments

describe("outcome measure due dates from confirmed assessments", () => {
  const c3 = client("client3");
  const rule = (params: Record<string, unknown>, verified = true): Rule =>
    ({
      id: "test-outcome",
      payorKey: "tricare_east",
      type: "outcome_measure_schedule",
      params,
      verified,
      source: { key: null, name: null, version: null, section: null, url: null },
    }) as unknown as Rule;
  const given = (typeKey: string, administeredOn: string, form: string | null = null) => ({
    typeKey,
    form,
    customName: null as string | null,
    administeredOn,
    name: typeKey === "vineland_3" ? "Vineland-3" : typeKey,
  });
  // Charlie's authorization: 2026-05-12 to 2026-11-09; today 2026-10-29. Assessments are due by
  // 2026-10-10 (30 days before it ends) when they lapse before 2026-11-10.
  const ctxWith = (
    assessments: ReturnType<typeof given>[],
    type: "initial" | "reauth" = "reauth",
    extra: Partial<EvalContext> = {},
  ) =>
    evalContextFor(c3, fullPlan(type), {
      asOf: "2026-10-29",
      attachments: [],
      assessments,
      authorization: { ...evalContextFor(c3).authorization!, kind: type },
      ...extra,
    });
  const noAuth = { authorization: null };
  const WHY = "(30 days before the authorization ends 2026-11-09)";

  it("annually: not due when it lasts past the authorization; the line says when it is next due", () => {
    const r = evaluateRule(rule({ annually: ["Vineland-3"] }), ctxWith([given("vineland_3", "2026-04-12")]));
    expect(r.status).toBe("pass");
    expect(r.schedule).toEqual([
      "Vineland-3 last given 2026-04-12 · next due 2027-04-12, after the authorization ends 2026-11-09",
    ]);
    expect(r.evidence[0]).toMatch(/Vineland-3: assessment Vineland-3 \(2026-04-12\), due every year/);
    expect(r.evidence).toContain(
      "Due 30 days before the authorization ends 2026-11-09 (practice setting) when a measure lapses before the next authorization starts",
    );
  });

  it("annually: due when it lapses before the next authorization; the newest administration counts", () => {
    const late = evaluateRule(
      rule({ annually: ["Vineland-3"] }),
      ctxWith([given("vineland_3", "2025-04-12"), given("vineland_3", "2025-11-01")]),
    );
    expect(late.status).toBe("fail");
    expect(late.message).toBe(
      "Outcome measures due: Vineland-3 (every year; last given 2025-11-01; overdue since 2026-10-10)",
    );
    expect(late.schedule).toEqual([`Vineland-3 last given 2025-11-01 · overdue since 2026-10-10 ${WHY}`]);
    // Before the due-by date it is due, not overdue.
    const early = evaluateRule(
      rule({ annually: ["Vineland-3"] }),
      ctxWith([given("vineland_3", "2025-11-01")], "reauth", { asOf: "2026-10-01" }),
    );
    expect(early.status).toBe("fail");
    expect(early.schedule).toEqual([`Vineland-3 last given 2025-11-01 · due by 2026-10-10 ${WHY}`]);
    // Lapsing the day the next authorization starts is not due.
    const onDay = evaluateRule(
      rule({ annually: ["Vineland-3"] }),
      ctxWith([given("vineland_3", "2025-11-10")]),
    );
    expect(onDay.status).toBe("pass");
    const lastDay = evaluateRule(
      rule({ annually: ["Vineland-3"] }),
      ctxWith([given("vineland_3", "2025-11-09")]),
    );
    expect(lastDay.status).toBe("fail");
  });

  it("the practice setting moves the due-by date", () => {
    const r = evaluateRule(
      rule({ annually: ["Vineland-3"] }),
      ctxWith([given("vineland_3", "2025-11-01")], "reauth", { asOf: "2026-10-01", assessmentDueDays: 1 }),
    );
    expect(r.schedule).toEqual([
      "Vineland-3 last given 2025-11-01 · due by 2026-11-08 (1 day before the authorization ends 2026-11-09)",
    ]);
  });

  it("every six months, with form-specific names", () => {
    const r = evaluateRule(
      rule({ every_6_months: ["PDDBI_parent", "PDDBI_teacher_or_BCBA"] }),
      ctxWith([given("pddbi", "2026-06-01", "parent"), given("pddbi", "2026-01-15", "teacher")]),
    );
    expect(r.status).toBe("fail");
    expect(r.message).toBe(
      "Outcome measures due: PDDBI teacher or BCBA (every six months; last given 2026-01-15; overdue since 2026-10-10)",
    );
    expect(r.schedule).toEqual([
      "PDDBI parent last given 2026-06-01 · next due 2026-12-01, after the authorization ends 2026-11-09",
      `PDDBI teacher or BCBA last given 2026-01-15 · overdue since 2026-10-10 ${WHY}`,
    ]);
    // A parent form does not count for the teacher form.
    const parentOnly = evaluateRule(
      rule({ every_6_months: ["PDDBI_teacher_or_BCBA"] }),
      ctxWith([given("pddbi", "2026-10-01", "parent")]),
    );
    expect(parentOnly.message).toBe(
      "Outcome measures due: PDDBI teacher or BCBA (every six months; overdue since 2026-10-10)",
    );
    expect(parentOnly.schedule).toEqual([
      `PDDBI teacher or BCBA not given yet · overdue since 2026-10-10 ${WHY}`,
    ]);
  });

  it("'PSI or SIPA' is met by either", () => {
    const r = evaluateRule(rule({ every_6_months: ["PSI or SIPA"] }), ctxWith([given("sipa", "2026-08-01")]));
    expect(r.status).toBe("pass");
    expect(r.schedule).toEqual([
      "PSI or SIPA last given 2026-08-01 · next due 2027-02-01, after the authorization ends 2026-11-09",
    ]);
  });

  it("every two years", () => {
    const rr = rule({ every_2_years: ["SRS-2"] });
    expect(evaluateRule(rr, ctxWith([given("srs_2", "2025-01-10")])).status).toBe("pass");
    const due = evaluateRule(rr, ctxWith([given("srs_2", "2024-10-01")]));
    expect(due.status).toBe("fail");
    expect(due.schedule).toEqual([`SRS-2 last given 2024-10-01 · overdue since 2026-10-10 ${WHY}`]);
  });

  it("initial authorization: the coming reauth's cadences apply, not the baseline list", () => {
    const rr = rule({ initial: ["Vineland-3", "SRS-2"], annually: ["Vineland-3"], every_6_months: ["PSI"] });
    const r = evaluateRule(
      rr,
      ctxWith([given("vineland_3", "2026-03-01"), given("srs_2", "2026-03-01")], "initial"),
    );
    // The Vineland-3 is annual (due 2027-03-01); SRS-2 is baseline only; the six-monthly PSI is checked.
    expect(r.status).toBe("fail");
    expect(r.message).toBe("Outcome measures due: PSI (every six months; overdue since 2026-10-10)");
    expect(r.schedule).toContain(
      "Vineland-3 last given 2026-03-01 · next due 2027-03-01, after the authorization ends 2026-11-09",
    );
  });

  it("initial request with no authorization yet: the baseline list, six months from the last administration", () => {
    const rr = rule({ initial: ["Vineland-3", "SRS-2"], annually: ["Vineland-3"] });
    const r = evaluateRule(
      rr,
      ctxWith([given("vineland_3", "2026-09-01"), given("srs_2", "2026-03-01")], "initial", noAuth),
    );
    expect(r.status).toBe("fail");
    expect(r.message).toBe(
      "Outcome measures due: SRS-2 (at baseline; last given 2026-03-01; overdue since 2026-09-01)",
    );
  });

  it("no current authorization: the cadence date from the last administration", () => {
    const ok = evaluateRule(
      rule({ annually: ["Vineland-3"] }),
      ctxWith([given("vineland_3", "2026-02-01")], "reauth", noAuth),
    );
    expect(ok.status).toBe("pass");
    expect(ok.schedule).toEqual(["Vineland-3 last given 2026-02-01 · due by 2027-02-01"]);
    const late = evaluateRule(
      rule({ annually: ["Vineland-3"] }),
      ctxWith([given("vineland_3", "2025-10-01")], "reauth", noAuth),
    );
    expect(late.status).toBe("fail");
    expect(late.message).toBe(
      "Outcome measures due: Vineland-3 (every year; last given 2025-10-01; overdue since 2026-10-01)",
    );
    expect(late.schedule).toEqual(["Vineland-3 last given 2025-10-01 · overdue since 2026-10-01"]);
    // An authorization that has ended is not current.
    const ended = evaluateRule(
      rule({ annually: ["Vineland-3"] }),
      ctxWith([given("vineland_3", "2026-02-01")], "reauth", { asOf: "2026-11-10" }),
    );
    expect(ended.schedule).toEqual(["Vineland-3 last given 2026-02-01 · due by 2027-02-01"]);
  });

  it("falls back to attachments when no assessment is on record, or the assessment is older", () => {
    const att = (title: string, documentDate: string) => ({ kind: "outcome_measure", title, documentDate });
    const ctx = {
      ...ctxWith([given("vineland_3", "2025-01-01")]),
      attachments: [att("Vineland-3", "2026-02-01")],
    };
    const r = evaluateRule(rule({ annually: ["Vineland-3"] }), ctx);
    expect(r.status).toBe("pass");
    expect(r.schedule).toEqual([
      "Vineland-3 last given 2026-02-01 · next due 2027-02-01, after the authorization ends 2026-11-09",
    ]);
    expect(r.evidence[0]).toMatch(/attachment "Vineland-3"/);
    // Unmapped tool names still work from attachments alone.
    const unmapped = evaluateRule(rule({ annually: ["CBCL"] }), {
      ...ctx,
      attachments: [att("CBCL", "2026-05-01")],
    });
    expect(unmapped.status).toBe("pass");
  });

  it("an unverified rule only warns, as before", () => {
    const r = evaluateRule(rule({ annually: ["Vineland-3"] }, false), ctxWith([]));
    expect(r.rawStatus).toBe("fail");
    expect(r.status).toBe("warn");
  });

  it("an 'other' assessment named like an acceptable tool counts for a required tool", () => {
    const req = {
      ...rule({ doc: "Validated ASD assessment tool result", options: ["ADOS-2", "CARS-2"] }),
      type: "required_document",
    } as Rule;
    const none = evaluateRule(req, ctxWith([]));
    expect(none.status).toBe("warn");
    const r = evaluateRule(
      req,
      ctxWith([{ ...given("other", "2026-05-01"), customName: "ADOS-2", name: "ADOS-2" }]),
    );
    expect(r.status).toBe("pass");
    expect(r.evidence[0]).toBe("assessment ADOS-2, given 2026-05-01");
  });
});

// ---------------------------------------------------------------- goal suggestions

describe("goal suggestions from ABLLS-R and AFLS areas", () => {
  const items = [
    assessmentItem(catalog, CLIENT, ablls),
    assessmentItem(
      catalog,
      CLIENT,
      row({
        typeKey: "ablls_r",
        administeredOn: day("2025-01-01"),
        scores: [score("requests", 0, 54)],
      }),
    ),
    assessmentItem(
      catalog,
      CLIENT,
      row({
        typeKey: "afls",
        module: "basic_living",
        administeredOn: day("2026-10-11"),
        scores: [
          score("safety", 6, 32),
          score("health", 4, 22),
          score("toileting", 30, 36),
          score("eating", 60, 60),
        ],
      }),
    ),
    assessmentItem(catalog, CLIENT, { ...draftSrs, typeKey: "ablls_r", scores: [score("math", 0, 20)] }),
  ];
  const s = suggestFromAreas(catalog, items);

  it("uses the latest confirmed administration of each, lowest share of possible first", () => {
    const abl = s.filter((x) => x.assessmentName === "ABLLS-R").map((x) => x.areaKey);
    expect(abl).toEqual(["intraverbals", "cooperation", "eating"]);
    expect(s.some((x) => x.areaKey === "requests" || x.areaKey === "math")).toBe(false);
    const afl = s.filter((x) => x.assessmentName === "AFLS · Basic Living Skills").map((x) => x.areaKey);
    // Health (18%) before safety (19%); fully scored eating is skipped.
    expect(afl).toEqual(["health", "safety", "toileting"]);
  });

  it("maps areas to goal bank domains from the catalog, or none (no template yet)", () => {
    const by = (k: string) => s.find((x) => x.areaKey === k)!;
    expect(by("intraverbals").goalBankDomain).toBe(4);
    expect(by("safety").goalBankDomain).toBe(13);
    expect(by("toileting").goalBankDomain).toBe(11);
    expect(by("health").goalBankDomain).toBeNull();
    expect(by("cooperation").goalBankDomain).toBeNull();
  });

  it("picks the tier by share of possible points", () => {
    expect(tierForShare(0)).toBe(1);
    expect(tierForShare(0.33)).toBe(1);
    expect(tierForShare(1 / 3)).toBe(2);
    expect(tierForShare(0.66)).toBe(2);
    expect(tierForShare(2 / 3)).toBe(3);
    expect(s.find((x) => x.areaKey === "toileting")!.tier).toBe(3);
  });

  it("limits each assessment to its lowest areas", () => {
    expect(suggestFromAreas(catalog, items, 1).map((x) => x.areaKey)).toEqual(["intraverbals", "health"]);
  });
});

// ---------------------------------------------------------------- pre-submission audit

describe("pre-submission audit: assessments", () => {
  const bundle = (over: {
    assessmentIds?: string[];
    administrations?: unknown[];
    pendingImports?: number;
    sections?: { key: string; title: string; state: string; redraftReason: string | null }[];
  }) =>
    ({
      plan: { assessmentIds: over.assessmentIds ?? [], sections: over.sections ?? [] },
      assessments: all,
      administrations: over.administrations ?? [],
      pendingImports: over.pendingImports ?? 0,
    }) as unknown as PlanBundle;
  const byId = (b: PlanBundle) => new Map(assessmentChecks(b).map((c) => [c.id, c]));

  it("warns when the plan uses no assessments", () => {
    expect(byId(bundle({})).get("assessments.none")).toMatchObject({ status: "warn" });
    expect(byId(bundle({ administrations: [{}] })).get("assessments.none")!.status).toBe("pass");
    expect(byId(bundle({ assessmentIds: [vinelandNew.id] })).get("assessments.none")!.status).toBe("pass");
  });

  it("warns, never blocks, when a selected assessment is still a draft", () => {
    const c = byId(bundle({ assessmentIds: [draftSrs.id] }));
    expect(c.get("assessments.none")!.status).toBe("warn");
    expect(c.get("assessments.drafts")).toMatchObject({ status: "warn" });
    expect(c.get("assessments.drafts")!.details).toEqual(["SRS-2, 2026-10-20"]);
  });

  it("warns about score imports not yet reviewed and sections flagged for a redraft", () => {
    const c = byId(
      bundle({
        assessmentIds: [vinelandNew.id],
        pendingImports: 2,
        sections: [
          { key: "assessment_results", title: "Assessment", state: "draft", redraftReason: "changed" },
          { key: "school_plan", title: "School", state: "not_applicable", redraftReason: "changed" },
        ],
      }),
    );
    expect(c.get("assessments.imports")!.status).toBe("warn");
    expect(c.get("assessments.redraft")).toMatchObject({ status: "warn", details: ["Assessment"] });
    expect([...c.values()].every((x) => x.status !== "fail")).toBe(true);
  });
});
