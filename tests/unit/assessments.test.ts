import { describe, expect, it } from "vitest";
import {
  CatalogError,
  KIND_BOUNDS,
  assessmentCatalog,
  catalogType,
  customScaleKey,
  parseAssessmentCatalog,
  scaleBounds,
  scalesFor,
} from "@/lib/assessments/catalog";
import { validateAssessment, AssessmentValidationError } from "@/lib/assessments/validate";
import {
  assessmentItem,
  formatScore,
  groupAssessments,
  skillsTotal,
  vbmappItem,
  type StoredAssessment,
} from "@/lib/assessments/view";

const catalog = assessmentCatalog();
const AS_OF = "2026-10-29";

const issuesOf = (fn: () => unknown): string[] => {
  try {
    fn();
  } catch (e) {
    if (e instanceof AssessmentValidationError) return e.issues;
    throw e;
  }
  throw new Error("expected a validation error");
};

const vineland = (over: Record<string, unknown> = {}) => ({
  typeKey: "vineland_3",
  form: "comprehensive_interview",
  respondent: "parent_caregiver",
  administeredOn: "2026-09-01",
  administeredBy: "AS",
  scores: [
    { scaleKey: "abc", value: 72 },
    { scaleKey: "communication", value: 70 },
  ],
  ...over,
});

// ---------------------------------------------------------------- catalog

describe("assessment catalog (seed/assessments.yaml)", () => {
  it("loads and lists every required type", () => {
    const keys = catalog.types.map((t) => t.key);
    for (const k of [
      "vbmapp",
      "ablls_r",
      "afls",
      "vineland_3",
      "srs_2",
      "pddbi",
      "psi_4",
      "sipa",
      "peak",
      "efl",
      "other",
    ])
      expect(keys).toContain(k);
  });

  it("groups types as skills, standardized, or other", () => {
    expect(catalogType(catalog, "ablls_r")!.group).toBe("skills");
    expect(catalogType(catalog, "vineland_3")!.group).toBe("standardized");
    expect(catalogType(catalog, "other")!.group).toBe("other");
  });

  it("ABLLS-R lists its 25 skill areas by name, scored as score of possible", () => {
    const t = catalogType(catalog, "ablls_r")!;
    expect(t.scales).toHaveLength(25);
    expect(t.scales.every((s) => s.kind === "score_of_possible")).toBe(true);
    expect(t.summaryTotal).toBe(true);
  });

  it("AFLS has the six modules, each with its own areas", () => {
    const t = catalogType(catalog, "afls")!;
    expect(t.modules.map((m) => m.key)).toEqual([
      "basic_living",
      "home",
      "community",
      "school",
      "vocational",
      "independent_living",
    ]);
    expect(scalesFor(t, "basic_living").map((s) => s.key)).toContain("toileting");
    expect(scalesFor(t, "home")).toEqual([]);
  });

  it("Vineland-3 has the four forms, standard scores 20-140, and v-scale subdomains under their domain", () => {
    const t = catalogType(catalog, "vineland_3")!;
    expect(t.forms.map((f) => f.key)).toEqual([
      "comprehensive_interview",
      "domain_interview",
      "parent_caregiver",
      "teacher",
    ]);
    const abc = t.scales.find((s) => s.key === "abc")!;
    expect(scaleBounds(abc)).toEqual({ min: 20, max: 140 });
    expect(t.scales.find((s) => s.key === "receptive")).toMatchObject({ parent: "communication", max: 24 });
    expect(t.summary).toEqual(["abc", "communication", "daily_living", "socialization"]);
  });

  it("holds names only: no item wording or long protocol text", () => {
    for (const t of catalog.types)
      for (const s of [...t.scales, ...t.modules.flatMap((m) => m.scales)]) {
        expect(s.name.length).toBeLessThanOrEqual(60);
        expect(s.name).not.toMatch(/[?]|\b(the child|when asked|does the|says)\b/i);
      }
  });

  it("uses the kind's bounds when a scale has no established range", () => {
    expect(scaleBounds({ kind: "t_score" })).toEqual(KIND_BOUNDS.t_score);
    expect(scaleBounds({ kind: "percentile" })).toEqual({ min: 0, max: 100 });
  });

  const base = (scales: unknown[], extra: Record<string, unknown> = {}) => ({
    version: 1,
    assessments: [{ key: "x", name: "X", group: "standardized", scales, ...extra }],
  });

  it("rejects duplicate type keys", () => {
    const doc = {
      version: 1,
      assessments: [
        { key: "x", name: "X", group: "other", custom_scales: true },
        { key: "x", name: "X2", group: "other", custom_scales: true },
      ],
    };
    expect(() => parseAssessmentCatalog(doc)).toThrow(/"x" is listed twice/);
  });

  it("rejects an unknown kind, a bad key, and unknown fields", () => {
    expect(() => parseAssessmentCatalog(base([{ key: "a", name: "A", kind: "z_score" }]))).toThrow(
      CatalogError,
    );
    expect(() => parseAssessmentCatalog(base([{ key: "Bad Key", name: "A", kind: "raw" }]))).toThrow(
      CatalogError,
    );
    expect(() =>
      parseAssessmentCatalog(base([{ key: "a", name: "A", kind: "raw", items: ["text"] }])),
    ).toThrow(CatalogError);
  });

  it("rejects a parent or summary scale that does not exist", () => {
    expect(() =>
      parseAssessmentCatalog(base([{ key: "a", name: "A", kind: "raw", parent: "nope" }])),
    ).toThrow(/unknown parent "nope"/);
    expect(() =>
      parseAssessmentCatalog(base([{ key: "a", name: "A", kind: "raw" }], { summary: ["b"] })),
    ).toThrow(/summary scale "b"/);
  });

  it("rejects a range outside the kind's bounds, min above max, or a range on score of possible", () => {
    expect(() =>
      parseAssessmentCatalog(base([{ key: "a", name: "A", kind: "percentile", max: 120 }])),
    ).toThrow(/outside what a percentile allows/);
    expect(() =>
      parseAssessmentCatalog(base([{ key: "a", name: "A", kind: "standard", min: 50, max: 40 }])),
    ).toThrow(/min above max/);
    expect(() =>
      parseAssessmentCatalog(base([{ key: "a", name: "A", kind: "score_of_possible", max: 10 }])),
    ).toThrow(/range comes from "possible"/);
  });

  it("rejects a type with no scales that does not allow custom ones", () => {
    expect(() => parseAssessmentCatalog(base([]))).toThrow(/has no scales/);
  });

  it("makes custom scale keys from names", () => {
    expect(customScaleKey("Motor Imitation!")).toBe("custom_motor_imitation");
    expect(customScaleKey("???")).toBe("custom_scale");
  });
});

// ---------------------------------------------------------------- validation

describe("assessment validation", () => {
  it("accepts a valid Vineland-3 and normalizes it", () => {
    const v = validateAssessment(catalog, vineland({ notes: "  " }), AS_OF);
    expect(v).toMatchObject({
      typeKey: "vineland_3",
      module: null,
      form: "comprehensive_interview",
      respondent: "parent_caregiver",
      administeredOn: "2026-09-01",
      administeredBy: "AS",
      notes: null,
    });
    expect(v.scores).toEqual([
      { scaleKey: "abc", scaleName: null, scaleKind: null, value: 72, possible: null },
      { scaleKey: "communication", scaleName: null, scaleKind: null, value: 70, possible: null },
    ]);
  });

  it("rejects values outside the catalog range", () => {
    const issues = issuesOf(() =>
      validateAssessment(
        catalog,
        vineland({
          scores: [
            { scaleKey: "abc", value: 150 },
            { scaleKey: "receptive", value: 0 },
            { scaleKey: "abc_pct", value: 101 },
          ],
        }),
        AS_OF,
      ),
    );
    expect(issues).toEqual([
      "Adaptive Behavior Composite must be between 20 and 140",
      "Receptive (v-scale) must be between 1 and 24",
      "Adaptive Behavior Composite percentile must be between 0 and 100",
    ]);
  });

  it("requires possible for a score of possible, and the score cannot exceed it", () => {
    const issues = issuesOf(() =>
      validateAssessment(
        catalog,
        {
          typeKey: "ablls_r",
          administeredOn: "2026-09-01",
          administeredBy: "AS",
          scores: [
            { scaleKey: "requests", value: 12, possible: 10 },
            { scaleKey: "labeling", value: 4 },
            { scaleKey: "imitation", value: 0, possible: 0 },
          ],
        },
        AS_OF,
      ),
    );
    expect(issues).toEqual([
      "Requests: the score (12) cannot be more than the possible (10)",
      "Labeling: enter the possible points",
      "Imitation: the possible points must be more than 0",
    ]);
  });

  it("rejects possible on a scale that is not a score of possible", () => {
    expect(
      issuesOf(() =>
        validateAssessment(
          catalog,
          vineland({ scores: [{ scaleKey: "abc", value: 80, possible: 140 }] }),
          AS_OF,
        ),
      ),
    ).toEqual(["Adaptive Behavior Composite: leave possible blank (it is a standard score)"]);
  });

  it("accepts a score equal to possible", () => {
    const v = validateAssessment(
      catalog,
      {
        typeKey: "ablls_r",
        administeredOn: "2026-09-01",
        administeredBy: "BCBA-Q",
        scores: [{ scaleKey: "requests", value: 10, possible: 10 }],
      },
      AS_OF,
    );
    expect(v.scores[0]).toMatchObject({ value: 10, possible: 10 });
  });

  it("rejects dates more than one day in the future, and allows one day", () => {
    expect(
      issuesOf(() => validateAssessment(catalog, vineland({ administeredOn: "2026-10-31" }), AS_OF)),
    ).toEqual(["The administration date cannot be in the future (today is 2026-10-29)"]);
    expect(
      validateAssessment(catalog, vineland({ administeredOn: "2026-10-30" }), AS_OF).administeredOn,
    ).toBe("2026-10-30");
    expect(
      issuesOf(() => validateAssessment(catalog, vineland({ administeredOn: "1999-12-31" }), AS_OF)),
    ).toEqual(["The administration date must be in 2000 or later"]);
  });

  it("rejects a date that is not a real calendar date", () => {
    expect(() => validateAssessment(catalog, vineland({ administeredOn: "2026-02-30" }), AS_OF)).toThrow();
  });

  it("rejects unknown scale keys and duplicates", () => {
    expect(
      issuesOf(() =>
        validateAssessment(
          catalog,
          vineland({
            scores: [
              { scaleKey: "abc", value: 80 },
              { scaleKey: "abc", value: 81 },
              { scaleKey: "iq", value: 90 },
            ],
          }),
          AS_OF,
        ),
      ),
    ).toEqual(["Adaptive Behavior Composite is entered twice", 'Unknown score "iq" for Vineland-3']);
  });

  it("rejects custom scales on a type that does not allow them", () => {
    expect(
      issuesOf(() =>
        validateAssessment(
          catalog,
          vineland({ customScales: [{ name: "Extra", kind: "standard", value: 90 }] }),
          AS_OF,
        ),
      ),
    ).toEqual(["Vineland-3 does not take added scales; use the listed ones"]);
  });

  it('"other": the BCBA names the assessment and its scales', () => {
    const v = validateAssessment(
      catalog,
      {
        typeKey: "other",
        customName: "Practice play checklist",
        administeredOn: "2026-09-01",
        administeredBy: "AS",
        customScales: [
          { name: "Pretend play", kind: "score_of_possible", value: 6, possible: 10 },
          { name: "Turn taking", kind: "percent", value: 40 },
        ],
      },
      AS_OF,
    );
    expect(v.customName).toBe("Practice play checklist");
    expect(v.scores).toEqual([
      {
        scaleKey: "custom_pretend_play",
        scaleName: "Pretend play",
        scaleKind: "score_of_possible",
        value: 6,
        possible: 10,
      },
      {
        scaleKey: "custom_turn_taking",
        scaleName: "Turn taking",
        scaleKind: "percent",
        value: 40,
        possible: null,
      },
    ]);
    expect(
      issuesOf(() =>
        validateAssessment(
          catalog,
          { typeKey: "other", administeredOn: "2026-09-01", administeredBy: "AS" },
          AS_OF,
        ),
      ),
    ).toEqual(["Name the assessment"]);
  });

  it("custom scales are range-checked by kind and must have distinct names", () => {
    expect(
      issuesOf(() =>
        validateAssessment(
          catalog,
          {
            typeKey: "other",
            customName: "X",
            administeredOn: "2026-09-01",
            administeredBy: "AS",
            customScales: [
              { name: "Turn taking", kind: "percent", value: 140 },
              { name: "turn taking", kind: "raw", value: 3 },
            ],
          },
          AS_OF,
        ),
      ),
    ).toEqual(["Turn taking must be between 0 and 100", "turn taking is entered twice"]);
  });

  it("modules: AFLS requires a known module and checks areas against it", () => {
    const base = { typeKey: "afls", administeredOn: "2026-09-01", administeredBy: "AS" };
    expect(issuesOf(() => validateAssessment(catalog, base, AS_OF))).toEqual(["Choose the AFLS module"]);
    expect(issuesOf(() => validateAssessment(catalog, { ...base, module: "space" }, AS_OF))).toEqual([
      'Unknown AFLS module "space"',
    ]);
    expect(
      issuesOf(() =>
        validateAssessment(
          catalog,
          { ...base, module: "home", scores: [{ scaleKey: "toileting", value: 1, possible: 2 }] },
          AS_OF,
        ),
      ),
    ).toEqual(['Unknown score "toileting" for AFLS Home Skills']);
    const ok = validateAssessment(
      catalog,
      {
        ...base,
        module: "home",
        customScales: [{ name: "Kitchen", kind: "score_of_possible", value: 3, possible: 8 }],
      },
      AS_OF,
    );
    expect(ok.module).toBe("home");
    expect(issuesOf(() => validateAssessment(catalog, vineland({ module: "basic_living" }), AS_OF))).toEqual([
      "Vineland-3 has no modules",
    ]);
  });

  it("forms and respondents must be ones the catalog lists", () => {
    expect(
      issuesOf(() =>
        validateAssessment(catalog, vineland({ form: "school", respondent: "neighbor" }), AS_OF),
      ),
    ).toEqual(['Unknown Vineland-3 form "school"', 'Unknown respondent "neighbor"']);
  });

  it("VB-MAPP is never entered by hand (it comes from the workbook import)", () => {
    expect(
      issuesOf(() =>
        validateAssessment(
          catalog,
          { typeKey: "vbmapp", administeredOn: "2026-09-01", administeredBy: "AS" },
          AS_OF,
        ),
      ),
    ).toEqual(["VB-MAPP is imported from its scoring workbook, not entered here"]);
    expect(
      issuesOf(() =>
        validateAssessment(
          catalog,
          { typeKey: "nope", administeredOn: "2026-09-01", administeredBy: "AS" },
          AS_OF,
        ),
      ),
    ).toEqual(['Unknown assessment type "nope"']);
  });

  it("administered by is initials or a staff code, never a full name", () => {
    expect(() => validateAssessment(catalog, vineland({ administeredBy: "Avery Sample" }), AS_OF)).toThrow();
    expect(validateAssessment(catalog, vineland({ administeredBy: "RBT-A" }), AS_OF).administeredBy).toBe(
      "RBT-A",
    );
  });

  it("rejects notes that look like a name, birth date, or member ID", () => {
    expect(
      issuesOf(() => validateAssessment(catalog, vineland({ notes: "DOB 03/04/2021, retest soon" }), AS_OF)),
    ).toEqual(["Leave names, dates of birth, and member IDs out of the notes"]);
    expect(() => validateAssessment(catalog, vineland({ notes: "x".repeat(1001) }), AS_OF)).toThrow();
  });

  it("drops blank rows the form sends", () => {
    const v = validateAssessment(
      catalog,
      vineland({
        scores: [
          { scaleKey: "abc", value: 72 },
          { scaleKey: "", value: null },
          { scaleKey: "motor", value: null, possible: null },
        ],
        customScales: [],
      }),
      AS_OF,
    );
    expect(v.scores.map((s) => s.scaleKey)).toEqual(["abc"]);
  });
});

// ---------------------------------------------------------------- display and grouping

const stored = (over: Partial<StoredAssessment> = {}): StoredAssessment => ({
  id: "a1",
  typeKey: "vineland_3",
  module: null,
  form: "comprehensive_interview",
  respondent: "parent_caregiver",
  customName: null,
  administeredOn: new Date("2026-09-01T00:00:00Z"),
  administeredBy: "AS",
  source: "manual",
  status: "draft",
  reviewedAt: null,
  notes: null,
  scores: [
    { scaleKey: "abc", scaleName: null, scaleKind: null, value: 72, possible: null },
    { scaleKey: "receptive", scaleName: null, scaleKind: null, value: 9, possible: null },
  ],
  ...over,
});

describe("skills totals", () => {
  it("sums score-of-possible areas that have a possible, ignoring subdomains", () => {
    expect(
      skillsTotal([
        { key: "a", name: "A", kind: "score_of_possible", value: 10, possible: 20, parent: null },
        { key: "b", name: "B", kind: "score_of_possible", value: 4.5, possible: 12, parent: null },
        { key: "c", name: "C", kind: "score_of_possible", value: 2, possible: 4, parent: "a" },
        { key: "d", name: "D", kind: "raw", value: 99, possible: null, parent: null },
      ]),
    ).toEqual({ value: 14.5, possible: 32, areas: 2 });
  });

  it("is null when nothing is scored", () => {
    expect(skillsTotal([])).toBeNull();
  });

  it("does not drift with decimals", () => {
    const s = Array.from({ length: 10 }, (_, i) => ({
      key: `k${i}`,
      name: "x",
      kind: "score_of_possible" as const,
      value: 0.1,
      possible: 0.3,
      parent: null,
    }));
    expect(skillsTotal(s)).toEqual({ value: 1, possible: 3, areas: 10 });
  });
});

describe("assessment list items", () => {
  it("names the type, form, and respondent, and shows the catalog's summary scales", () => {
    const item = assessmentItem(catalog, "c1", stored());
    expect(item).toMatchObject({
      typeName: "Vineland-3",
      formName: "Comprehensive Interview Form",
      respondentName: "Parent or caregiver",
      administeredOn: "2026-09-01",
      status: "draft",
      href: null,
    });
    expect(item.summary.map((s) => [s.key, s.value])).toEqual([["abc", 72]]);
    expect(item.scores.find((s) => s.key === "receptive")).toMatchObject({
      name: "Receptive (v-scale)",
      parent: "communication",
    });
  });

  it("skills assessments summarize as the total of their areas", () => {
    const item = assessmentItem(
      catalog,
      "c1",
      stored({
        typeKey: "ablls_r",
        form: null,
        respondent: null,
        scores: [
          { scaleKey: "requests", scaleName: null, scaleKind: null, value: 12, possible: 40 },
          { scaleKey: "labeling", scaleName: null, scaleKind: null, value: 8, possible: 30 },
        ],
      }),
    );
    expect(item.summary).toEqual([
      {
        key: "total",
        name: "Total (2 areas)",
        kind: "score_of_possible",
        value: 20,
        possible: 70,
        parent: null,
        computed: true,
      },
    ]);
  });

  it('"other" shows its custom name and first scales', () => {
    const item = assessmentItem(
      catalog,
      "c1",
      stored({
        typeKey: "other",
        form: null,
        respondent: null,
        customName: "Practice play checklist",
        scores: [
          { scaleKey: "custom_play", scaleName: "Play", scaleKind: "percent", value: 40, possible: null },
        ],
      }),
    );
    expect(item.typeName).toBe("Practice play checklist");
    expect(item.summary.map((s) => s.name)).toEqual(["Play"]);
  });

  it("adapts a VB-MAPP administration into the same list, linking to its grid", () => {
    const item = vbmappItem(catalog, "c1", {
      id: "v1",
      adminNumber: 2,
      testDate: new Date("2026-10-09T00:00:00Z"),
      testerInitials: "AS",
      totals: { total: 77.5, levels: { "1": 40, "2": 30, "3": 7.5 } },
      verified: true,
      reviewedAt: null,
    });
    expect(item).toMatchObject({
      id: "v1",
      typeKey: "vbmapp",
      typeName: "VB-MAPP",
      source: "vbmapp_import",
      status: "confirmed",
      administeredOn: "2026-10-09",
      administeredBy: "AS",
      href: "/clients/c1/vbmapp#admin-2",
    });
    expect(item.summary).toEqual([
      { key: "total", name: "Milestones total", kind: "raw", value: 77.5, possible: 170, parent: null },
    ]);
    expect(item.scores.map((s) => [s.key, s.value, s.possible])).toEqual([
      ["total", 77.5, 170],
      ["level_1", 40, 45],
      ["level_2", 30, 60],
      ["level_3", 7.5, 65],
    ]);
  });

  it("an unverified VB-MAPP administration reads as draft", () => {
    const item = vbmappItem(catalog, "c1", {
      id: "v1",
      adminNumber: 1,
      testDate: null,
      testerInitials: null,
      totals: { total: 0, levels: {} },
      verified: false,
      reviewedAt: null,
    });
    expect(item).toMatchObject({ status: "draft", administeredOn: null });
  });
});

describe("grouping repeats", () => {
  const v25 = assessmentItem(
    catalog,
    "c1",
    stored({
      id: "old",
      administeredOn: new Date("2025-09-01T00:00:00Z"),
      scores: [
        { scaleKey: "abc", scaleName: null, scaleKind: null, value: 68, possible: null },
        { scaleKey: "communication", scaleName: null, scaleKind: null, value: 66, possible: null },
      ],
    }),
  );
  const v26 = assessmentItem(
    catalog,
    "c1",
    stored({
      id: "new",
      scores: [{ scaleKey: "abc", scaleName: null, scaleKind: null, value: 72, possible: null }],
    }),
  );
  const pParent = assessmentItem(
    catalog,
    "c1",
    stored({ id: "pp", typeKey: "pddbi", form: "parent", scores: [] }),
  );
  const pTeacher = assessmentItem(
    catalog,
    "c1",
    stored({ id: "pt", typeKey: "pddbi", form: "teacher", scores: [] }),
  );

  it("groups the same type, newest first, and compares summary scales oldest to newest", () => {
    const [g] = groupAssessments([v25, v26]);
    expect(g!.label).toBe("Vineland-3");
    expect(g!.items.map((i) => i.id)).toEqual(["new", "old"]);
    expect(g!.progress!.dates).toEqual(["2025-09-01", "2026-09-01"]);
    expect(g!.progress!.rows).toEqual([
      {
        key: "abc",
        name: "Adaptive Behavior Composite",
        kind: "standard",
        cells: [
          { value: 68, possible: null },
          { value: 72, possible: null },
        ],
        change: 4,
      },
      {
        key: "communication",
        name: "Communication",
        kind: "standard",
        cells: [{ value: 66, possible: null }, null],
        change: null,
      },
    ]);
  });

  it("a single administration has no progress table", () => {
    expect(groupAssessments([v26])[0]!.progress).toBeNull();
  });

  it("orders groups by their newest administration", () => {
    const vb = vbmappItem(catalog, "c1", {
      id: "v",
      adminNumber: 1,
      testDate: new Date("2026-10-20T00:00:00Z"),
      testerInitials: "AS",
      totals: { total: 10, levels: {} },
      verified: true,
      reviewedAt: null,
    });
    expect(groupAssessments([v25, v26, vb]).map((g) => g.typeKey)).toEqual(["vbmapp", "vineland_3"]);
  });

  it("keeps PDDBI parent and teacher forms apart", () => {
    expect(groupAssessments([pParent, pTeacher]).map((g) => g.label)).toEqual([
      "PDDBI · Parent Form",
      "PDDBI · Teacher Form",
    ]);
  });
});

describe("score display", () => {
  it("formats each kind", () => {
    expect(formatScore("score_of_possible", 12, 20)).toBe("12 / 20");
    expect(formatScore("standard", 85, null)).toBe("85");
    expect(formatScore("t_score", 62, null)).toBe("T 62");
    expect(formatScore("percentile", 3, null)).toBe("3rd percentile");
    expect(formatScore("percentile", 0.1, null)).toBe("0.1 percentile");
    expect(formatScore("percentile", 12, null)).toBe("12th percentile");
    expect(formatScore("percentile", 21, null)).toBe("21st percentile");
    expect(formatScore("percent", 45.5, null)).toBe("45.5%");
    expect(formatScore("raw", 77.5, 170)).toBe("77.5 / 170");
    expect(formatScore("age_equivalent_months", 30, null)).toBe("30 mo");
  });
});
