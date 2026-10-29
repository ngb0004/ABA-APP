import { describe, expect, it } from "vitest";
import { loadPayorSeed, resolvePayorRules } from "@/lib/payors/load";
import { evaluateRule, evaluateRules } from "@/lib/payors/evaluate";
import { RULE_TYPES, type Rule } from "@/lib/payors/types";
import {
  credentialsMissingFromQuote,
  numbersMissingFromQuote,
  quoteIsSubstantial,
} from "@/lib/rules-watch/text";
import { client, evalContextFor, fullPlan } from "../helpers/synthetic-eval";

const seed = loadPayorSeed();
const c1 = client("client1");
const c2 = client("client2");
const c3 = client("client3");
const rulesFor = (k: string) => resolvePayorRules(seed, k);
const ctx1 = evalContextFor(c1, fullPlan("initial"));
const ctx2 = evalContextFor(c2, fullPlan("reauth"));
const ctx3 = evalContextFor(c3, fullPlan("reauth"));
const verified = (r: Rule): Rule => ({ ...r, verified: true });
const find = (k: string, type: string, pred: (r: Rule) => boolean = () => true) =>
  rulesFor(k).find((r) => r.type === type && pred(r))!;

describe("seed loader", () => {
  it("loads all 10 payors and resolves inheritance and YAML anchors", () => {
    expect(seed.payors).toHaveLength(10);
    const amerigroup = rulesFor("amerigroup");
    expect(amerigroup.filter((r) => r.inheritedFrom === "ga_medicaid").length).toBe(
      rulesFor("ga_medicaid").length,
    );
    const west = rulesFor("tricare_west");
    expect(west.filter((r) => r.type === "daily_cap")).toHaveLength(3); // from *tricare_common
    expect(west.some((r) => r.type === "required_document" && /PCM letter/.test(String(r.params.doc)))).toBe(
      true,
    );
  });
  it("records a source and an unverified flag on every seeded rule", () => {
    for (const p of seed.payors)
      for (const r of rulesFor(p.id)) {
        expect(r.verified).toBe(false);
        expect(r).toHaveProperty("source.section");
      }
  });
  it("records where official rules were read: each quote is substantial and has every number in the rule", () => {
    let quoted = 0;
    for (const p of seed.payors)
      for (const r of [...p.rules, ...p.extra_rules]) {
        if (!r.quote) continue;
        quoted++;
        expect(r.source, r.quote).toBeTruthy();
        expect(seed.documents[r.source!]?.secondary ?? false).toBe(false);
        expect(quoteIsSubstantial(r.quote), r.quote).toBe(true);
        expect(numbersMissingFromQuote(r.params, r.quote), r.quote).toEqual([]);
        expect(credentialsMissingFromQuote(r.params, r.quote), r.quote).toEqual([]);
        expect(r.page, r.quote).toBeDefined();
      }
    expect(quoted).toBeGreaterThan(80);
  });
  it("renamed documents list their earlier keys, and no rule cites a missing document", () => {
    expect(seed.documents.ga_medicaid_asd_manual?.formerly).toContain("ga_medicaid_asd_manual_2026q3");
    for (const p of seed.payors)
      for (const r of [...p.rules, ...p.extra_rules])
        if (r.source) expect(seed.documents).toHaveProperty(r.source);
  });
  it("uses every rule type in the seed", () => {
    const types = new Set(seed.payors.flatMap((p) => rulesFor(p.id).map((r) => r.type)));
    for (const t of RULE_TYPES) expect(types.has(t)).toBe(true);
  });
});

describe("unverified rules never fail", () => {
  it("returns only warn or n/a for every seeded rule against all 3 synthetic clients", () => {
    for (const [k, ctx] of [
      ["amerigroup", ctx1],
      ["cigna_evernorth", ctx2],
      ["tricare_east", ctx3],
    ] as const) {
      for (const r of evaluateRules(rulesFor(k), ctx)) expect(["warn", "n/a"]).toContain(r.status);
    }
  });
  it("still records what a verified rule would have returned", () => {
    const r = evaluateRule(find("tricare_east", "min_sessions_per_auth"), ctx3);
    expect(r.status).toBe("warn");
    expect(r.rawStatus).toBe("fail");
  });
});

describe("rule types (evaluated as verified)", () => {
  it("required_document: present, missing, reauth-only, and if-applicable", () => {
    expect(
      evaluateRule(
        verified(find("ga_medicaid", "required_document", (r) => r.params.doc === "Diagnostic evaluation")),
        ctx1,
      ).status,
    ).toBe("pass");
    expect(
      evaluateRule(
        verified(find("amerigroup", "required_document", (r) => /Amerigroup/.test(String(r.params.doc)))),
        ctx1,
      ).status,
    ).toBe("fail");
    expect(
      evaluateRule(
        verified(find("ga_medicaid", "required_document", (r) => r.params.when === "reauth")),
        ctx1,
      ).status,
    ).toBe("n/a");
    expect(
      evaluateRule(verified(find("ga_medicaid", "required_document", (r) => r.params.doc === "IFSP")), ctx1)
        .status,
    ).toBe("n/a"); // age 3
    expect(evaluateRule(verified(find("cigna_evernorth", "required_document")), ctx2).status).toBe("pass");
  });
  it("signature_type: always a manual check", () => {
    expect(evaluateRule(verified(find("ga_medicaid", "signature_type")), ctx1).status).toBe("warn");
  });
  it("form_address: needs an office in the service state", () => {
    const r = verified(find("cigna_evernorth", "form_address"));
    expect(evaluateRule(r, ctx2).status).toBe("pass");
    expect(evaluateRule(r, { ...ctx2, offices: [] }).status).toBe("fail");
  });
  it("supervision_ratio: Cigna 1 h per 10 h per technician passes for Client 2; TRICARE monthly in-person fails for Client 3", () => {
    const cigna = evaluateRule(
      verified(find("cigna_evernorth", "supervision_ratio", (x) => x.params.per_technician === true)),
      ctx2,
    );
    expect(cigna.status).toBe("pass");
    expect(cigna.evidence.some((e) => /RBT-A/.test(e))).toBe(true);
    const tri = evaluateRule(verified(find("tricare_east", "supervision_ratio")), ctx3);
    expect(tri.status).toBe("fail");
    expect(tri.message).toMatch(/hard alert/);
    expect(tri.evidence.filter((e) => /MISSED/.test(e))).toHaveLength(1);
  });
  it("daily_cap: passes for Client 3, fails when a day exceeds the cap", () => {
    const r = verified(find("tricare_east", "daily_cap", (x) => x.params.all_services_hours === 8));
    expect(evaluateRule(r, ctx3).status).toBe("pass");
    const day = c3.sessions[0]!.date;
    expect(
      evaluateRule(r, {
        ...ctx3,
        sessions: [...ctx3.sessions, { cptCode: "97153", date: day, units: 40, inPerson: true }],
      }).status,
    ).toBe("fail");
  });
  it("concurrent_billing: overlapping 97153/97155 fails", () => {
    const r = verified(find("tricare_east", "concurrent_billing"));
    expect(evaluateRule(r, ctx3).status).toBe("pass");
    const s = ctx3.sessions.find((x) => x.cptCode === "97153")!;
    expect(
      evaluateRule(r, {
        ...ctx3,
        sessions: [
          ...ctx3.sessions,
          {
            cptCode: "97155",
            date: s.date,
            units: 4,
            inPerson: true,
            startMinute: (s.startMinute ?? 0) + 30,
          },
        ],
      }).status,
    ).toBe("fail");
  });
  it("min_sessions_per_auth: Client 3 is under the TRICARE caregiver-training minimum", () => {
    const r = evaluateRule(verified(find("tricare_east", "min_sessions_per_auth")), ctx3);
    expect(r.status).toBe("fail");
    expect(r.message).toMatch(/97156/);
    expect(r.evidence[0]).toMatch(/^3 97156 session\(s\) delivered of 6/);
  });
  it("unit_limit: Cigna 97151 progress report within 6 h; TRICARE reassessment within 24 units", () => {
    expect(evaluateRule(verified(find("cigna_evernorth", "unit_limit")), ctx2).status).toBe("pass");
    expect(evaluateRule(verified(find("tricare_east", "unit_limit")), ctx3).status).toBe("pass");
    const over = {
      ...ctx2,
      authorization: {
        ...ctx2.authorization!,
        units: [{ cptCode: "97151", approvedUnits: 32, unitBasis: "auth" as const }],
      },
    };
    expect(evaluateRule(verified(find("cigna_evernorth", "unit_limit")), over).status).toBe("fail");
  });
  it("unit_basis: Cigna wants monthly units (Client 2 requested weekly); GA allows 13/26-week periods", () => {
    const cigna = evaluateRule(verified(find("cigna_evernorth", "unit_basis")), ctx2);
    expect(cigna.status).toBe("fail");
    expect(cigna.evidence[0]).toMatch(/per month/);
    expect(evaluateRule(verified(find("ga_medicaid", "unit_basis")), ctx1).status).toBe("pass");
  });
  it("request_timing: Amerigroup 97151 due 3 months before expiry; TRICARE window open", () => {
    const amRule = find("amerigroup", "request_timing", (x) => x.params.months_before_auth_end !== undefined);
    const am = evaluateRule(verified(amRule), ctx1);
    expect(am.evidence[0]).toMatch(/97151 \(separate request\) due 2026-09-28/);
    // Client 1's 90-day initial auth started after that date: it applies to the next authorization.
    expect(am.status).toBe("pass");
    const longer = { ...ctx1, authorization: { ...ctx1.authorization!, startDate: "2026-06-01" } };
    expect(evaluateRule(verified(amRule), longer).status).toBe("fail");
    const window = verified(
      find("tricare_east", "request_timing", (x) => x.params.submit_up_to_days_before_auth_end === 60),
    );
    expect(evaluateRule(window, ctx3).status).toBe("warn");
    expect(evaluateRule(window, { ...ctx3, packetSubmitted: true }).status).toBe("pass");
  });
  it("outcome_measure_schedule: Client 3 measures are due (PDDBI stale, teacher form missing)", () => {
    const r = evaluateRule(verified(find("tricare_east", "outcome_measure_schedule")), ctx3);
    expect(r.status).toBe("fail");
    expect(r.message).toMatch(/PDDBI_parent/);
    expect(r.message).toMatch(/PDDBI_teacher_or_BCBA/);
    expect(r.message).not.toMatch(/PSI/);
  });
  it("staff_credential: technicians must be RBTs (TRICARE West checklist)", () => {
    const r = verified(find("tricare_west", "staff_credential", (x) => x.params.role === "technician"));
    expect(evaluateRule(r, ctx3).status).toBe("pass");
    expect(
      evaluateRule(r, {
        ...ctx3,
        sessions: [{ cptCode: "97153", date: "2026-10-01", units: 4, inPerson: true, providerRole: "BCaBA" }],
      }).status,
    ).toBe("fail");
  });
  it("staff_credential: TRICARE East accepts any listed technician credential", () => {
    const r = verified(
      find("tricare_east", "staff_credential", (x) => Array.isArray(x.params.must_be_any_of)),
    );
    const at = (providerRole: string) =>
      evaluateRule(r, {
        ...ctx3,
        sessions: [{ cptCode: "97153", date: "2026-10-01", units: 4, inPerson: true, providerRole }],
      }).status;
    expect(at("ABAT")).toBe("pass");
    expect(at("BCAT")).toBe("pass");
    expect(at("RBT")).toBe("pass");
    expect(at("BCaBA")).toBe("fail");
  });
  it("supervision_ratio: Cigna EN0499 expects 1 to 2 h per 10 h direct", () => {
    const r = verified(
      find("cigna_evernorth", "supervision_ratio", (x) => x.params.max_hours_per_10_direct === 2),
    );
    const sessions = (supHours: number) => [
      {
        cptCode: "97153",
        date: "2026-09-02",
        units: 40,
        inPerson: true,
        providerId: "t1",
        providerRole: "RBT",
      },
      {
        cptCode: "97155",
        date: "2026-09-02",
        units: supHours * 4,
        inPerson: true,
        providerId: "b1",
        providerRole: "BCBA",
      },
    ];
    const ctx = (h: number) => ({
      ...ctx2,
      authorization: { ...ctx2.authorization!, startDate: "2026-09-01", endDate: "2027-02-28" },
      asOf: "2026-10-15",
      sessions: sessions(h),
    });
    expect(evaluateRule(r, ctx(0.5)).status).toBe("fail");
    expect(evaluateRule(r, ctx(1.5)).status).toBe("pass");
    // More supervision than usual is flagged for review, never blocked.
    expect(evaluateRule(r, ctx(3)).status).toBe("warn");
  });
  it("supervision_ratio: Aetna compares authorized 97155 to 97153", () => {
    const r = verified(find("aetna", "supervision_ratio", (x) => x.params.basis === "authorization"));
    const auth = (sup: number) => ({
      ...ctx2,
      authorization: {
        ...ctx2.authorization!,
        units: [
          { cptCode: "97153", approvedUnits: 80, unitBasis: "week" as const },
          { cptCode: "97155", approvedUnits: sup, unitBasis: "week" as const },
        ],
      },
    });
    expect(evaluateRule(r, auth(4)).status).toBe("fail"); // 0.5 h per 10
    expect(evaluateRule(r, auth(12)).status).toBe("pass"); // 1.5 h per 10
    expect(evaluateRule(r, auth(24)).status).toBe("warn"); // 3 h per 10
  });
  it("rules the app cannot compute become manual checks, never passes", () => {
    for (const p of seed.payors)
      for (const r of rulesFor(p.id)) {
        const res = evaluateRule(verified(r), ctx2);
        if (res.status === "pass")
          expect(res.message).not.toMatch(/^Request timing noted$|^Concurrent billing allowed$/);
      }
    const cig = evaluateRule(
      verified(find("cigna_evernorth", "concurrent_billing", (x) => !Array.isArray(x.params.codes))),
      ctx2,
    );
    expect(cig.status).toBe("warn");
    expect(cig.message).toMatch(/manual check/);
    const school = evaluateRule(
      verified(
        find("ga_medicaid", "required_document", (x) => x.params.when === "school_based_public_school"),
      ),
      ctx1,
    );
    expect(school.status).toBe("warn");
  });
  it("event_trigger: n/a until the event occurs, then requires the document", () => {
    const r = verified(find("amerigroup", "event_trigger", (x) => x.params.event === "bcba_transfer"));
    expect(evaluateRule(r, ctx1).status).toBe("n/a");
    expect(evaluateRule(r, { ...ctx1, client: { ...ctx1.client, events: ["bcba_transfer"] } }).status).toBe(
      "fail",
    );
  });
  it("plan_content: GA must-include sections and BCBA signature", () => {
    const r = verified(
      find(
        "ga_medicaid",
        "plan_content",
        (x) =>
          Array.isArray(x.params.must_include) && (x.params.must_include as string[]).includes("crisis_plan"),
      ),
    );
    // All mapped sections present; the "if applicable" items (behavior goals, telehealth) stay a manual check.
    const full = evaluateRule(r, ctx1);
    expect(full.status).toBe("warn");
    expect(full.message).toMatch(/manual check/);
    expect(full.evidence.some((e) => /telehealth readiness/.test(e))).toBe(true);
    const partial = {
      ...ctx1,
      plan: {
        ...ctx1.plan!,
        sections: ctx1.plan!.sections.filter((s) => s.key !== "crisis_plan"),
        allApprovedByBcba: false,
      },
    };
    const res = evaluateRule(r, partial);
    expect(res.status).toBe("fail");
    expect(res.message).toMatch(/crisis plan/);
    expect(res.message).toMatch(/BCBA/);
    // Plans written with the eleven-section structure are checked against their own sections.
    const legacy = { ...ctx1, plan: fullPlan("initial", "legacy") };
    expect(evaluateRule(r, legacy).message).toMatch(/manual check/);
    const legacyPartial = {
      ...legacy,
      plan: { ...legacy.plan!, sections: legacy.plan!.sections.filter((s) => s.key !== "crisis") },
    };
    expect(evaluateRule(r, legacyPartial).message).toMatch(/crisis plan/);
  });
  it("submission_channel: informational pass with the channel", () => {
    const r = evaluateRule(verified(find("cigna_evernorth", "submission_channel")), ctx2);
    expect(r.status).toBe("pass");
    expect(r.message).toMatch(/ABA@Evernorth.com/);
  });
});

describe("review fixes: rules the app cannot fully decide warn instead of failing or passing", () => {
  const byDoc = (k: string, re: RegExp) =>
    verified(find(k, "required_document", (r) => re.test(String(r.params.doc))));
  const att = (kind: string, title: string, documentDate: string | null = "2026-10-01") => ({
    kind,
    title,
    documentDate,
  });

  it("if-applicable documents the app cannot judge are a manual check", () => {
    const r = evaluateRule(byDoc("ga_medicaid", /hospitalization/i), ctx1);
    expect(r.status).toBe("warn");
    expect(r.message).toMatch(/if applicable \(manual check\)/);
  });

  it("checks authorized supervision on an initial request with no sessions yet", () => {
    const r = verified(find("aetna", "supervision_ratio", (x) => x.params.basis === "authorization"));
    const ctx = {
      ...ctx2,
      sessions: [],
      authorization: {
        ...ctx2.authorization!,
        units: [
          { cptCode: "97153", approvedUnits: 100, unitBasis: "week" as const },
          { cptCode: "97155", approvedUnits: 5, unitBasis: "week" as const },
        ],
      },
    };
    expect(evaluateRule(r, ctx).status).toBe("fail");
  });

  it("the packet's own per-goal graphs satisfy Georgia's line-graph requirement on a reauth", () => {
    const r = byDoc("ga_medicaid", /line graphs/i);
    expect(evaluateRule(r, ctx2).status).toBe("pass");
    const noData = { ...ctx2, plan: { ...ctx2.plan!, goalsHaveData: false } };
    expect(evaluateRule(r, noData).status).toBe("fail");
  });

  it("checks a document's age against the requested effective date", () => {
    const rule = verified({
      ...byDoc("ga_medicaid", /updated data/i),
      params: { doc: "Progress data export", when: "reauth", max_age_months_before_effective: 2 },
    });
    const end = ctx2.authorization!.endDate;
    const withDoc = (date: string | null) => ({
      ...ctx2,
      attachments: [...ctx2.attachments, att("other", "Progress data export", date)],
    });
    expect(evaluateRule(rule, withDoc(end)).status).toBe("pass");
    expect(evaluateRule(rule, withDoc("2025-01-01")).status).toBe("fail");
    expect(evaluateRule(rule, withDoc(null)).status).toBe("warn");
    // The plan's own updated data has no single date: the BCBA confirms it.
    expect(evaluateRule(byDoc("ga_medicaid", /updated data/i), ctx2).status).toBe("warn");
  });

  it("a diagnosis rule matches the diagnostic evaluation and lists what to confirm", () => {
    const r = evaluateRule(byDoc("cigna_evernorth", /independently licensed/i), ctx2);
    expect(r.status).toBe("warn");
    expect(r.evidence.some((e) => /diagnostician name/.test(e))).toBe(true);
    expect(r.evidence[0]).toMatch(/attachment/);
  });

  it("an acceptable alternative turns a missing document into a manual check", () => {
    const r = evaluateRule(byDoc("aetna", /release for communication/i), { ...ctx2, attachments: [] });
    expect(r.status).toBe("warn");
    expect(r.message).toMatch(/alternative/);
  });

  it("a rule listing acceptable tools is not met by any diagnostic evaluation", () => {
    const r = byDoc("tricare_east", /Validated ASD assessment/i);
    const dxOnly = { ...ctx3, attachments: [att("diagnostic_evaluation", "Diagnostic evaluation")] };
    expect(evaluateRule(r, dxOnly).status).toBe("warn");
    const withTool = { ...dxOnly, attachments: [...dxOnly.attachments, att("other", "ADOS-2 report")] };
    expect(evaluateRule(r, withTool).status).toBe("pass");
    // Whole words only, and the diagnostic evaluation is still required.
    const statement = { ...dxOnly, attachments: [...dxOnly.attachments, att("other", "Parent statement")] };
    expect(evaluateRule(r, statement).status).toBe("warn");
    expect(evaluateRule(r, { ...ctx3, attachments: [att("other", "STAT results")] }).status).toBe("warn");
  });

  it("events: works out what it can from the records, asks about the rest", () => {
    const brk = verified(
      find("cigna_evernorth", "event_trigger", (x) => x.params.event === "break_in_treatment"),
    );
    const s = { cptCode: "97153", units: 4, inPerson: true, providerRole: "RBT" };
    const auth = {
      ...ctx2.authorization!,
      kind: "initial" as const,
      startDate: "2026-08-20",
      endDate: "2027-02-19",
    };
    const weekly = ["2026-08-24", "2026-09-14", "2026-10-05", "2026-10-26"].map((date) => ({ ...s, date }));
    const steady = { ...ctx2, authorization: auth, sessions: weekly };
    const gap = { ...steady, sessions: [weekly[0]!] }; // nothing since August: a break in progress
    expect(evaluateRule(brk, gap).status).toBe("warn"); // occurred; its actions are a manual check
    expect(evaluateRule(brk, steady).status).toBe("n/a");
    // Sessions before a reauth's start are not loaded, so the app cannot rule a break out.
    expect(evaluateRule(brk, { ...steady, authorization: { ...auth, kind: "reauth" as const } }).status).toBe(
      "warn",
    );
    const unknown = verified(
      find("ga_medicaid", "event_trigger", (x) => x.params.event === "additional_units_requested"),
    );
    expect(evaluateRule(unknown, ctx1).status).toBe("warn");
    // Recorded events are still ruled out when absent.
    expect(
      evaluateRule(
        verified(find("amerigroup", "event_trigger", (x) => x.params.event === "bcba_transfer")),
        ctx1,
      ).status,
    ).toBe("n/a");
  });

  it("outcome measures due annually are checked on a reauth", () => {
    const r = verified(
      find(
        "tricare_east",
        "outcome_measure_schedule",
        (x) => x.source.key === "tricare_east_provider_handbook_2026",
      ),
    );
    const om = (title: string, date: string) => att("outcome_measure", title, date);
    const ctx = (vinelandDate: string) => ({
      ...ctx3,
      attachments: [
        om("PDDBI parent", "2026-09-01"),
        om("PSI", "2026-09-01"),
        om("SRS-2", "2026-09-01"),
        om("Vineland-3", vinelandDate),
      ],
    });
    expect(evaluateRule(r, ctx("2026-03-01")).status).toBe("pass");
    const late = evaluateRule(r, ctx("2025-04-01"));
    expect(late.status).toBe("fail");
    expect(late.message).toMatch(/Vineland-3 \(every year\)/);
  });

  it("plan content that applies only to reauths or school services is gated", () => {
    const reauthOnly = verified(find("ga_medicaid", "plan_content", (x) => x.params.when === "reauth"));
    expect(evaluateRule(reauthOnly, ctx1).status).toBe("n/a");
    const school = verified(
      find("ga_medicaid", "plan_content", (x) => x.params.when === "school_based_services"),
    );
    expect(evaluateRule(school, { ...ctx1, plan: null }).status).toBe("warn");
  });

  it("billing allowed only under a condition flags overlapping sessions for a look", () => {
    const r = verified(find("bcbs_ga_anthem", "concurrent_billing"));
    const s = { date: "2026-10-01", units: 4, inPerson: true, startMinute: 600 };
    const overlap = {
      ...ctx2,
      sessions: [
        { ...s, cptCode: "97153" },
        { ...s, cptCode: "97155" },
      ],
    };
    expect(evaluateRule(r, overlap).status).toBe("warn");
    expect(evaluateRule(r, { ...ctx2, sessions: [] }).status).toBe("pass");
  });

  it("a BCBA delivering direct service is not a technician", () => {
    const r = verified(find("ga_medicaid", "staff_credential", (x) => x.params.role === "technician"));
    const at = (providerRole: string) =>
      evaluateRule(r, {
        ...ctx1,
        sessions: [{ cptCode: "97153", date: "2026-10-01", units: 4, inPerson: true, providerRole }],
      }).status;
    expect(at("BCBA")).toBe("pass");
    expect(at("BCaBA")).toBe("fail");
  });

  it("a verification quote must name every credential the rule enforces", () => {
    expect(
      credentialsMissingFromQuote(
        { must_be_any_of: ["RBT", "ABAT"] },
        "Registered Behavior Technicians (RBT)",
      ),
    ).toEqual(["ABAT"]);
    expect(credentialsMissingFromQuote({ supervised_by: ["BCBA-D"] }, "supervised by a BCBA/BCBA-D")).toEqual(
      [],
    );
  });
});
