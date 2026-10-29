import { describe, expect, it } from "vitest";
import { loadPayorSeed, resolvePayorRules } from "@/lib/payors/load";
import { evaluateRule, evaluateRules } from "@/lib/payors/evaluate";
import { RULE_TYPES, type Rule } from "@/lib/payors/types";
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
    const cigna = evaluateRule(verified(find("cigna_evernorth", "supervision_ratio")), ctx2);
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
    const am = evaluateRule(verified(find("amerigroup", "request_timing")), ctx1);
    expect(am.evidence[0]).toMatch(/97151 \(separate request\) due 2026-09-28/);
    // Client 1's 90-day initial auth started after that date: it applies to the next authorization.
    expect(am.status).toBe("pass");
    const longer = { ...ctx1, authorization: { ...ctx1.authorization!, startDate: "2026-06-01" } };
    expect(evaluateRule(verified(find("amerigroup", "request_timing")), longer).status).toBe("fail");
    expect(evaluateRule(verified(find("tricare_east", "request_timing")), ctx3).status).toBe("warn");
    expect(
      evaluateRule(verified(find("tricare_east", "request_timing")), { ...ctx3, packetSubmitted: true })
        .status,
    ).toBe("pass");
  });
  it("outcome_measure_schedule: Client 3 measures are due (PDDBI stale, teacher form missing)", () => {
    const r = evaluateRule(verified(find("tricare_east", "outcome_measure_schedule")), ctx3);
    expect(r.status).toBe("fail");
    expect(r.message).toMatch(/PDDBI_parent/);
    expect(r.message).toMatch(/PDDBI_teacher_or_BCBA/);
    expect(r.message).not.toMatch(/PSI/);
  });
  it("staff_credential: technicians must be RBTs", () => {
    const r = verified(find("tricare_east", "staff_credential", (x) => x.params.role === "technician"));
    expect(evaluateRule(r, ctx3).status).toBe("pass");
    expect(
      evaluateRule(r, {
        ...ctx3,
        sessions: [{ cptCode: "97153", date: "2026-10-01", units: 4, inPerson: true, providerRole: "BCaBA" }],
      }).status,
    ).toBe("fail");
  });
  it("event_trigger: n/a until the event occurs, then requires the document", () => {
    const r = verified(find("amerigroup", "event_trigger"));
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
    expect(evaluateRule(r, ctx1).status).toBe("pass");
    const partial = {
      ...ctx1,
      plan: {
        ...ctx1.plan!,
        sections: ctx1.plan!.sections.filter((s) => s.key !== "crisis"),
        allApprovedByBcba: false,
      },
    };
    const res = evaluateRule(r, partial);
    expect(res.status).toBe("fail");
    expect(res.message).toMatch(/crisis plan/);
    expect(res.message).toMatch(/BCBA/);
  });
  it("submission_channel: informational pass with the channel", () => {
    const r = evaluateRule(verified(find("cigna_evernorth", "submission_channel")), ctx2);
    expect(r.status).toBe("pass");
    expect(r.message).toMatch(/ABA@Evernorth.com/);
  });
});
