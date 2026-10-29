/**
 * Payor rule evaluator. Given a client + authorization + plan context, returns
 * {rule, status, evidence} per rule. Rules are data: every threshold comes from
 * rule.params. An unverified rule can only produce "warn", never "fail"
 * (its would-be status is kept in rawStatus).
 */
import { addDays, addMonths, diffDays, type Day } from "../dates";
import { supervisionByMonth, DIRECT_CODE, SUPERVISION_CODE } from "../supervision";
import { authWeeks } from "../utilization";
import { sectionsForTopic } from "../plan/sections";
import type { EvalContext } from "./context";
import type { Rule, RuleResult, RuleStatus, RuleType } from "./types";

type Outcome = { status: RuleStatus; message: string; evidence?: string[] };
type Evaluator = (p: Record<string, unknown>, ctx: EvalContext, rule: Rule) => Outcome;

const num = (v: unknown): number | undefined => (typeof v === "number" ? v : undefined);
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
const fmt = (n: number) => String(Math.round(n * 100) / 100);
const pct = (n: number) => `${fmt(n * 100)}%`;
const NA = (message: string): Outcome => ({ status: "n/a", message });

/** A rule the app cannot compute from its parameters: show what it says and ask for a manual check. */
function guidance(p: Record<string, unknown>, message: string, skip: string[] = []): Outcome {
  return {
    status: "warn",
    message: `${message} (manual check)`,
    evidence: Object.keys(p)
      .filter((k) => !skip.includes(k))
      .map((k) => `${k.replace(/_/g, " ")}: ${typeof p[k] === "string" ? p[k] : JSON.stringify(p[k])}`),
  };
}
const has = (p: Record<string, unknown>, keys: string[]) => keys.some((k) => p[k] !== undefined);

const norm = (s: string) =>
  s
    .toLowerCase()
    .replace(/\(.*?\)/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

/** Generic document matching (not payor-specific): attachment kinds and titles, plus plan-generated documents. */
export function documentPresent(
  doc: string,
  ctx: EvalContext,
): { present: boolean; how: string; documentDate?: Day | null } {
  const n = norm(doc);
  const kindFor: [RegExp, string][] = [
    [
      /\bdiagnostic (?:re)?evaluation\b|\b(?:asd|autism)\b.*\bdiagnosis\b|\bdiagnosis\b.*\b(?:clinician|provider)\b/,
      "diagnostic_evaluation",
    ],
    [/\biep\b/, "iep"],
    [/\bifsp\b/, "ifsp"],
  ];
  for (const [re, kind] of kindFor) {
    if (re.test(n)) {
      const hit = ctx.attachments.find((a) => a.kind === kind);
      if (hit) return { present: true, how: `attachment "${hit.title}"`, documentDate: hit.documentDate };
    }
  }
  if (/\bplan of care\b|\btreatment plan\b/.test(n) && ctx.plan)
    return { present: true, how: "treatment plan in this packet" };
  // The packet itself carries progress data and a line graph per goal on reauthorizations.
  if (
    /\bupdated data\b|\bgraphs?\b/.test(n) &&
    ctx.plan?.type === "reauth" &&
    ctx.plan.goalsHaveData !== false
  )
    return { present: true, how: "reauth plan with per-goal progress graphs" };
  const hit = ctx.attachments.find(
    (a) => norm(a.title) === n || norm(a.title).includes(n) || n.includes(norm(a.title)),
  );
  if (hit && norm(hit.title).length > 3)
    return { present: true, how: `attachment "${hit.title}"`, documentDate: hit.documentDate };
  return { present: false, how: "" };
}

/** Events the app records on the client; any other event a rule names is a manual check. */
/** Roles that supervise; their own direct sessions are not technician sessions. */
const SUPERVISOR_ROLES = ["BCBA", "BCBA-D"];

export const RECORDED_EVENTS = [
  "bcba_transfer",
  "insurance_changed_to_umr",
  "plan_is_aetna_better_health_medicaid",
];

/** Events the app can work out from its own records (undefined when it cannot tell). */
function derivedEvent(event: string, p: Record<string, unknown>, ctx: EvalContext): boolean | undefined {
  if (event === "initial_evaluation")
    return ctx.plan
      ? ctx.plan.type === "initial"
      : ctx.authorization
        ? ctx.authorization.kind === "initial"
        : undefined;
  if (event === "telehealth_service")
    return ctx.sessions.length ? ctx.sessions.some((x) => !x.inPerson) : undefined;
  if (event === "break_in_treatment") {
    const limit = num(p.threshold_calendar_days_gt);
    if (limit === undefined || !ctx.authorization) return undefined;
    // Gaps between sessions, from the authorization start to the first, and from the last to today.
    const days = [...new Set(ctx.sessions.map((x) => x.date).filter((d) => d <= ctx.asOf))].sort();
    const points = [
      ctx.authorization.startDate,
      ...days,
      ctx.asOf < ctx.authorization.endDate ? ctx.asOf : ctx.authorization.endDate,
    ];
    if (points.some((d, i) => i > 0 && diffDays(d, points[i - 1]!) > limit)) return true;
    // Sessions before this authorization are not loaded, so only a first authorization can be ruled out.
    return ctx.authorization.kind === "initial" ? false : undefined;
  }
  return undefined;
}

function dailyHours(ctx: EvalContext, code?: string) {
  const byDay = new Map<Day, number>();
  for (const s of ctx.sessions) {
    if (code && s.cptCode !== code) continue;
    byDay.set(s.date, (byDay.get(s.date) ?? 0) + s.units / 4);
  }
  return byDay;
}

function authRange(ctx: EvalContext) {
  return ctx.authorization
    ? { start: ctx.authorization.startDate, end: ctx.authorization.endDate, asOf: ctx.asOf }
    : null;
}

const EVALUATORS: Record<RuleType, Evaluator> = {
  required_document(p, ctx) {
    const doc = str(p.doc) ?? "document";
    const when = str(p.when);
    if (when === "reauth" && ctx.plan?.type !== "reauth")
      return NA(`${doc}: only required for reauthorization`);
    if (when === "treatment" && !ctx.plan) return NA(`${doc}: only required for treatment requests`);
    if (when && !["reauth", "treatment", "if_applicable"].includes(when)) {
      // The app does not track this condition (e.g., school-based or telehealth services): ask, never assume.
      const { present, how } = documentPresent(doc, ctx);
      if (present) return { status: "pass", message: `${doc}: present`, evidence: [how] };
      return {
        status: "warn",
        message: `${doc}: required when ${when.replace(/_/g, " ")} (manual check)`,
        evidence: [str(p.note) ?? "Attach it if this applies to the request"],
      };
    }
    let applicabilityUnknown = false;
    if (when === "if_applicable") {
      // Only conditions the app tracks decide applicability; anything else is the BCBA's call.
      const tracked = /ifsp/i.test(doc)
        ? ctx.client.ageYears < 3
        : /\biep\b/i.test(doc)
          ? ctx.client.hasIep
          : undefined;
      if (tracked === false) return NA(`${doc}: not applicable to this client`);
      applicabilityUnknown = tracked === undefined;
    }
    const checklist = (Array.isArray(p.must_include) ? (p.must_include as string[]) : []).map(
      (x) => `Manual check: document includes ${x}`,
    );
    // A rule listing acceptable tools is met only by one of them, never by any diagnostic evaluation.
    const options = Array.isArray(p.options) ? (p.options as string[]) : [];
    if (options.length) {
      // Whole words only: "STAT" is a tool, "statement" is not.
      const match = ctx.attachments.find((a) =>
        options.some((o) => ` ${norm(a.title)} `.includes(` ${norm(o)} `)),
      );
      const dxNeeded = /\bdiagnostic evaluation\b/.test(norm(doc));
      const dx = dxNeeded ? ctx.attachments.find((a) => a.kind === "diagnostic_evaluation") : undefined;
      if (match && (!dxNeeded || dx))
        return {
          status: "pass",
          message: `${doc}: present`,
          evidence: [`attachment "${match.title}"`, ...(dx ? [`attachment "${dx.title}"`] : [])],
        };
      return {
        status: "warn",
        message: match
          ? `${doc}: ${match.title} attached; confirm the diagnostic evaluation (manual check)`
          : `${doc}: confirm one of ${options.join(", ")} is attached (manual check)`,
        evidence: [str(p.note) ?? "Attach the assessment tool result"],
      };
    }
    const { present, how, documentDate } = documentPresent(doc, ctx);
    const age = num(p.max_age_months_before_effective);
    if (present && age !== undefined) {
      // Requested effective date: the day after the authorization being renewed ends.
      const effective = ctx.authorization ? addDays(ctx.authorization.endDate, 1) : null;
      if (!documentDate || !effective)
        return {
          status: "warn",
          message: `${doc}: present; confirm it is no more than ${age} months older than the requested effective date (manual check)`,
          evidence: [how],
        };
      return documentDate >= addMonths(effective, -age)
        ? { status: "pass", message: `${doc}: present and current`, evidence: [how, `Dated ${documentDate}`] }
        : {
            status: "fail",
            message: `${doc}: dated ${documentDate}, more than ${age} months before the requested effective date ${effective}`,
            evidence: [how],
          };
    }
    if (present)
      return checklist.length
        ? {
            status: "warn",
            message: `${doc}: present; confirm its contents (manual check)`,
            evidence: [how, ...checklist],
          }
        : { status: "pass", message: `${doc}: present`, evidence: [how] };
    if (p.optional === true) return NA(`${doc}: optional, not attached`);
    const alt = str(p.alternative);
    if (alt)
      return {
        status: "warn",
        message: `${doc}: not attached; acceptable alternative: ${alt} (manual check)`,
        evidence: [
          str(p.note) ?? `Attach the document, or confirm the record documents: ${alt}`,
          ...checklist,
        ],
      };
    if (applicabilityUnknown)
      return {
        status: "warn",
        message: `${doc}: required if applicable (manual check)`,
        evidence: [str(p.note) ?? "Attach it if this applies to the client", ...checklist],
      };
    return {
      status: "fail",
      message: `${doc}: missing`,
      evidence: [str(p.note) ?? "Attach the document to the packet"],
    };
  },

  signature_type(p) {
    return {
      status: "warn",
      message: `Signature requirement for ${str(p.document) ?? "documents"}: ${str(p.requirement) ?? "see source"}`,
      evidence: ["Manual check: confirm signature type before submission"],
    };
  },

  form_address(p, ctx) {
    if (p.use !== "service_state_office")
      return { status: "warn", message: `Form address rule: ${JSON.stringify(p)}`, evidence: [] };
    const office = ctx.offices.find((o) => o.state === ctx.client.serviceState);
    return office
      ? {
          status: "pass",
          message: `Use the ${ctx.client.serviceState} office address on the form`,
          evidence: [office.address],
        }
      : {
          status: "fail",
          message: `No practice office on file for service state ${ctx.client.serviceState}`,
          evidence: ["Add the office under org settings"],
        };
  },

  supervision_ratio(p, ctx) {
    const range = authRange(ctx);
    if (!range) return NA("No authorization");
    const evidence: string[] = [];
    let failed = false;
    const minPct =
      num(p.min_pct_of_hours_per_month) ??
      num(p.min_pct_of_hours) ??
      num(p.min_pct_per_technician) ??
      (num(p.hours_supervision_per_10_hours_direct) !== undefined
        ? num(p.hours_supervision_per_10_hours_direct)! * 10
        : undefined);
    const perTech = p.per_technician === true || p.min_pct_per_technician !== undefined;
    // Range of supervision hours per 10 direct hours. basis "authorization" compares authorized units instead.
    const min10 = num(p.min_hours_per_10_direct);
    const max10 = num(p.max_hours_per_10_direct);
    let aboveRange = false;
    if ((min10 !== undefined || max10 !== undefined) && p.basis === "authorization") {
      const sup = ctx.authorization?.units.find((u) => u.cptCode === SUPERVISION_CODE);
      const dir = ctx.authorization?.units.find((u) => u.cptCode === DIRECT_CODE);
      if (!sup || !dir || sup.unitBasis !== dir.unitBasis || dir.approvedUnits <= 0)
        return NA(`${SUPERVISION_CODE} and ${DIRECT_CODE} are not both authorized on the same basis`);
      const per10 = (sup.approvedUnits / dir.approvedUnits) * 10;
      const low = min10 !== undefined && per10 < min10 - 1e-9;
      const high = max10 !== undefined && per10 > max10 + 1e-9;
      const range = `${min10 ?? 0}–${max10 ?? "∞"}`;
      return {
        status: low ? "fail" : high ? "warn" : "pass",
        message: low
          ? `Authorized ${SUPERVISION_CODE} is below ${range} h per 10 h of ${DIRECT_CODE}`
          : high
            ? `Authorized ${SUPERVISION_CODE} is above the usual ${range} h per 10 h of ${DIRECT_CODE}`
            : `Authorized ${SUPERVISION_CODE} is within ${range} h per 10 h of ${DIRECT_CODE}`,
        evidence: [`Authorized: ${fmt(per10)} h ${SUPERVISION_CODE} per 10 h ${DIRECT_CODE}`],
      };
    }
    // Delivered-session checks need at least one complete month of service.
    const months = supervisionByMonth(ctx.sessions, range);
    if (!months.length) return NA("No complete months of service yet");
    for (const m of months) {
      if (minPct !== undefined) {
        if (perTech) {
          for (const t of m.perTechnician) {
            const ok = t.ratio !== null && t.ratio * 100 >= minPct - 1e-9;
            if (!ok) failed = true;
            evidence.push(
              `${m.month} technician ${t.providerId}: ${fmt(t.supervisionHours)} h supervision / ${fmt(t.directHours)} h direct = ${t.ratio === null ? "n/a" : pct(t.ratio)} (min ${minPct}%)${ok ? "" : " — below minimum"}`,
            );
          }
        } else {
          const ok = m.ratio !== null && m.ratio * 100 >= minPct - 1e-9;
          if (!ok) failed = true;
          evidence.push(
            `${m.month}: ${fmt(m.supervisionHours)} h supervision / ${fmt(m.directHours)} h direct = ${m.ratio === null ? "n/a" : pct(m.ratio)} (min ${minPct}%)${ok ? "" : " — below minimum"}`,
          );
        }
      }
      if ((min10 !== undefined || max10 !== undefined) && m.directHours > 0) {
        const per10 = (m.supervisionHours / m.directHours) * 10;
        const low = min10 !== undefined && per10 < min10 - 1e-9;
        if (low) failed = true;
        if (max10 !== undefined && per10 > max10 + 1e-9) aboveRange = true;
        evidence.push(
          `${m.month}: ${fmt(per10)} h supervision per 10 h direct (expected ${min10 ?? 0}–${max10 ?? "∞"})${low ? " — below minimum" : ""}`,
        );
      }
      const maxPer10 = num(p.max_protocol_mod_hours_per_10_direct);
      if (maxPer10 !== undefined && m.directHours > 0) {
        const per10 = (m.supervisionHours / m.directHours) * 10;
        if (per10 > maxPer10 + 1e-9) failed = true;
        evidence.push(`${m.month}: ${fmt(per10)} h protocol modification per 10 h direct (max ${maxPer10})`);
      }
      const minOnsite = num(p.min_onsite_face_to_face_hours_per_month);
      if (minOnsite !== undefined) {
        const ok = m.inPersonSupervisionHours >= minOnsite;
        if (!ok) failed = true;
        evidence.push(
          `${m.month}: ${fmt(m.inPersonSupervisionHours)} h in-person supervision (min ${minOnsite})${ok ? "" : " — below minimum"}`,
        );
      }
      const minSessions = num(p.min_in_person_sessions_per_client_per_month);
      if (minSessions !== undefined) {
        const ok = m.inPersonSupervisionSessions >= minSessions;
        if (!ok) failed = true;
        evidence.push(
          `${m.month}: ${m.inPersonSupervisionSessions} in-person ${str(p.code) ?? SUPERVISION_CODE} session(s) (min ${minSessions})${ok ? "" : " — MISSED"}`,
        );
      }
    }
    const maxAuthPct = num(p.max_pct_authorized);
    if (maxAuthPct !== undefined && ctx.authorization) {
      const sup = ctx.authorization.units.find((u) => u.cptCode === SUPERVISION_CODE);
      const dir = ctx.authorization.units.find((u) => u.cptCode === DIRECT_CODE);
      if (sup && dir && sup.unitBasis === dir.unitBasis && dir.approvedUnits > 0) {
        const r = sup.approvedUnits / dir.approvedUnits;
        if (r * 100 > maxAuthPct + 1e-9) failed = true;
        evidence.push(`Authorized supervision is ${pct(r)} of authorized direct (max ${maxAuthPct}%)`);
      }
    }
    const severity = str(p.severity_if_missed);
    if (!evidence.length) return guidance(p, "Supervision guidance");
    return {
      status: failed ? "fail" : aboveRange ? "warn" : "pass",
      message: failed
        ? `Supervision requirement not met${severity === "hard_alert" ? " (hard alert: recoupment risk)" : ""}`
        : aboveRange
          ? "Supervision is above the payor's usual range"
          : "Supervision requirement met",
      evidence,
    };
  },

  daily_cap(p, ctx) {
    const code = str(p.code);
    const cap = num(p.hours) ?? num(p.all_services_hours);
    if (cap === undefined)
      return { status: "warn", message: "Daily cap rule has no hour limit", evidence: [] };
    const over = [...dailyHours(ctx, code).entries()].filter(([, h]) => h > cap + 1e-9);
    const label = code ? `${code}` : "all services";
    return over.length
      ? {
          status: "fail",
          message: `Daily cap exceeded for ${label} (max ${cap} h/day) on ${over.length} day(s)`,
          evidence: over.slice(0, 10).map(([d, h]) => `${d}: ${fmt(h)} h`),
        }
      : { status: "pass", message: `No day exceeds ${cap} h for ${label}` };
  },

  concurrent_billing(p, ctx) {
    const codes = Array.isArray(p.codes) ? (p.codes as string[]) : [];
    const overlaps = () => {
      if (codes.length < 2) return [];
      const [a, b] = codes as [string, string];
      const out: string[] = [];
      for (const x of ctx.sessions.filter((s) => s.cptCode === a))
        for (const y of ctx.sessions.filter((s) => s.cptCode === b)) {
          if (x.date !== y.date) continue;
          const xs = x.startMinute ?? 0;
          const ys = y.startMinute ?? 0;
          if (xs < ys + y.units * 15 && ys < xs + x.units * 15) out.push(`${x.date}: ${a} and ${b} overlap`);
        }
      return out;
    };
    if (p.allowed !== false) {
      const condition = str(p.condition);
      const label = codes.length
        ? `${codes.join(" and ")} may be billed together`
        : "Concurrent billing allowed";
      if (!condition) return { status: "pass", message: label };
      // Allowed only under a condition the records cannot show: overlapping sessions need a human look.
      const found = overlaps();
      return found.length
        ? {
            status: "warn",
            message: `${label} only if: ${condition}. Confirm these sessions (manual check)`,
            evidence: found.slice(0, 10),
          }
        : { status: "pass", message: `${label} (only if: ${condition}); no overlapping sessions` };
    }
    if (codes.length < 2) return guidance(p, "Concurrent billing restriction", ["allowed"]);
    const [a, b] = codes as [string, string];
    const conflicts = overlaps();
    return conflicts.length
      ? { status: "fail", message: `${a} and ${b} billed concurrently`, evidence: conflicts.slice(0, 10) }
      : { status: "pass", message: `No concurrent ${a}/${b} billing` };
  },

  min_sessions_per_auth(p, ctx) {
    const range = authRange(ctx);
    if (!range) return NA("No authorization");
    const code = str(p.code) ?? "";
    const min = num(p.min_sessions) ?? 0;
    const delivered = ctx.sessions.filter(
      (s) => s.cptCode === code && s.date >= range.start && s.date <= range.end && s.date <= ctx.asOf,
    ).length;
    const total = diffDays(range.end, range.start) + 1;
    const elapsed = Math.min(total, Math.max(0, diffDays(ctx.asOf, range.start) + 1));
    const expectedByNow = Math.floor((min * elapsed) / total);
    const remainingDays = Math.max(0, diffDays(range.end, ctx.asOf));
    const evidence = [
      `${delivered} ${code} session(s) delivered of ${min} required this authorization`,
      `Pace target by today: ${expectedByNow}`,
      `${remainingDays} day(s) left in authorization`,
    ];
    if (ctx.asOf >= range.end && delivered < min)
      return { status: "fail", message: `${code}: ${delivered} of ${min} required sessions`, evidence };
    if (delivered < expectedByNow)
      return {
        status: "fail",
        message: `${code}: below minimum (${delivered} delivered; ${min} required per authorization)`,
        evidence,
      };
    return { status: "pass", message: `${code}: on pace (${delivered} of ${min})`, evidence };
  },

  unit_limit(p, ctx) {
    if (p.guide_only === true || p.code === undefined) return guidance(p, "Unit guidance", ["guide_only"]);
    if (!ctx.authorization) return NA("No authorization");
    const code = str(p.code) ?? "";
    const u = ctx.authorization.units.find((x) => x.cptCode === code);
    if (!u) return NA(`${code} not requested on this authorization`);
    let max: number | undefined;
    if (num(p.max_hours) !== undefined) max = num(p.max_hours)! * 4;
    else if (ctx.authorization.kind === "initial" && num(p.initial_units) !== undefined)
      max = num(p.initial_units)! + (num(p.initial_outcome_units) ?? 0);
    else if (ctx.authorization.kind === "reauth" && num(p.reassessment_units) !== undefined)
      max = num(p.reassessment_units)!;
    if (max === undefined) return guidance(p, `Unit limit for ${code}`, ["code"]);
    const requested =
      u.unitBasis === "auth"
        ? u.approvedUnits
        : u.approvedUnits *
          (u.unitBasis === "week" ? authWeeks(ctx.authorization.startDate, ctx.authorization.endDate) : 6);
    return requested <= max
      ? {
          status: "pass",
          message: `${code}: ${fmt(requested)} units within limit of ${max}`,
          evidence: [str(p.purpose) ?? ""].filter(Boolean),
        }
      : { status: "fail", message: `${code}: ${fmt(requested)} units exceeds limit of ${max}`, evidence: [] };
  },

  unit_basis(p, ctx) {
    if (!has(p, ["request_per", "treatment_periods_weeks", "assessment_increment_months"]))
      return guidance(p, "Units and billing");
    if (!ctx.authorization) return NA("No authorization");
    const evidence: string[] = [];
    let failed = false;
    const per = str(p.request_per);
    if (per) {
      const wrong = ctx.authorization.units.filter((u) => u.unitBasis !== per && u.unitBasis !== "auth");
      if (wrong.length) {
        failed = true;
        evidence.push(
          `Request units per ${per}${p.convert_from ? ` (convert from per ${p.convert_from})` : ""}: ${wrong.map((u) => `${u.cptCode} is per ${u.unitBasis}`).join(", ")}`,
        );
      }
    }
    const periods = Array.isArray(p.treatment_periods_weeks) ? (p.treatment_periods_weeks as number[]) : null;
    if (periods) {
      const weeks = authWeeks(ctx.authorization.startDate, ctx.authorization.endDate);
      const ok = periods.some((w) => Math.abs(w - weeks) <= 1);
      if (!ok) failed = true;
      evidence.push(
        `Authorization spans ${fmt(weeks)} weeks; allowed treatment periods: ${periods.join(" or ")} weeks`,
      );
    }
    if (num(p.assessment_increment_months) !== undefined)
      evidence.push(`Assessment (97151) requested in ${p.assessment_increment_months}-month increments`);
    return {
      status: failed ? "fail" : "pass",
      message: failed ? "Unit basis does not match payor requirement" : "Unit basis matches",
      evidence,
    };
  },

  request_timing(p, ctx) {
    if (
      !has(p, [
        "months_before_auth_end",
        "submit_up_to_days_before_auth_end",
        "report_due_days_after_assessment",
        "with_other_codes",
      ])
    )
      return guidance(p, "Request timing");
    if (!ctx.authorization) return NA("No authorization");
    const end = ctx.authorization.endDate;
    const evidence: string[] = [];
    let due: Day | null = null;
    if (num(p.months_before_auth_end) !== undefined) {
      due = addMonths(end, -num(p.months_before_auth_end)!);
      evidence.push(
        `${str(p.code) ?? "Request"}${p.separate_request ? " (separate request)" : ""} due ${due}`,
      );
    }
    let windowOpen = false;
    if (num(p.submit_up_to_days_before_auth_end) !== undefined) {
      // A window opening, not a deadline: earliest date a reauth may be submitted.
      const opens = addDays(end, -num(p.submit_up_to_days_before_auth_end)!);
      evidence.push(`Reauth submission window opens ${opens}${p.day_type ? ` (${p.day_type} days)` : ""}`);
      windowOpen = ctx.asOf >= opens && ctx.asOf <= end;
    }
    if (num(p.report_due_days_after_assessment) !== undefined)
      evidence.push(`Report due ${p.report_due_days_after_assessment} days after assessment`);
    if (p.with_other_codes === true)
      evidence.push(`${str(p.code) ?? "Assessment"} requested together with other codes`);
    if (due && due < ctx.authorization.startDate) {
      // A short authorization can put the due date before it began: it applies to the next authorization.
      evidence.push("Due date falls before this authorization started; applies to the next authorization");
      return { status: "pass", message: "Request timing: not due for this authorization", evidence };
    }
    if (due && !ctx.packetSubmitted && ctx.asOf >= due)
      return { status: "fail", message: `Request timing: due ${due} and not yet submitted`, evidence };
    if (windowOpen && !ctx.packetSubmitted)
      return {
        status: "warn",
        message: `Reauth submission window is open (authorization ends ${end})`,
        evidence,
      };
    if (!due && num(p.submit_up_to_days_before_auth_end) === undefined)
      return { status: "warn", message: "Request timing (manual check)", evidence };
    return {
      status: "pass",
      message: due ? `Request timing: next due ${due}` : "Reauth submission window not open yet",
      evidence,
    };
  },

  outcome_measure_schedule(p, ctx) {
    if (!has(p, ["initial", "every_6_months", "annually", "every_2_years"]))
      return guidance(p, "Outcome measures");
    const list = (k: string) => (Array.isArray(p[k]) ? (p[k] as string[]) : []);
    // Each measure is due within its cadence; a measure listed under several cadences takes the shortest.
    const due = new Map<string, { cutoff: Day; cadence: string }>();
    if (ctx.plan?.type === "initial" || ctx.authorization?.kind === "initial")
      for (const m of list("initial"))
        due.set(m, { cutoff: addMonths(ctx.asOf, -6), cadence: "at baseline" });
    else
      for (const [k, months, cadence] of [
        ["every_2_years", 24, "every two years"],
        ["annually", 12, "every year"],
        ["every_6_months", 6, "every six months"],
      ] as const)
        for (const m of list(k)) {
          // Free-text cadence entries ("two_year_review") are not measures to find in attachments.
          if (/review/i.test(m)) continue;
          due.set(m, { cutoff: addMonths(ctx.asOf, -months), cadence });
        }
    if (!due.size) return NA("No outcome measures due");
    const missing: string[] = [];
    const evidence: string[] = [];
    for (const [m, { cutoff, cadence }] of due) {
      const alts = m.split(/\s+or\s+/i).map((x) => norm(x.replace(/_/g, " ").replace(/\(.*?\)/g, "")));
      const hit = ctx.attachments.find(
        (a) =>
          a.kind === "outcome_measure" &&
          alts.some(
            (alt) =>
              norm(a.title).includes(alt.split(" ")[0]!) &&
              (!alt.includes("parent") || norm(a.title).includes("parent")) &&
              (!alt.includes("teacher") || /teacher|bcba/.test(norm(a.title))),
          ) &&
          (a.documentDate ?? "") >= cutoff,
      );
      if (hit) evidence.push(`${m}: ${hit.title} (${hit.documentDate})`);
      else missing.push(`${m} (${cadence})`);
    }
    if (p.full_publisher_report_required === true)
      evidence.push("Full publisher report required for each measure");
    return missing.length
      ? { status: "fail", message: `Outcome measures due: ${missing.join(", ")}`, evidence }
      : { status: "pass", message: "Outcome measures current", evidence };
  },

  staff_credential(p, ctx) {
    if (str(p.role) === "technician") {
      const anyOf = Array.isArray(p.must_be_any_of)
        ? (p.must_be_any_of as string[])
        : [str(p.must_be) ?? "RBT"];
      const label = anyOf.join(" or ");
      // A supervising BCBA delivering direct service is not a technician.
      const bad = ctx.sessions.filter(
        (s) =>
          s.cptCode === DIRECT_CODE &&
          !SUPERVISOR_ROLES.includes(s.providerRole ?? "") &&
          !anyOf.includes(s.providerRole ?? ""),
      );
      return bad.length
        ? {
            status: "fail",
            message: `${bad.length} ${DIRECT_CODE} session(s) delivered by staff who are not ${label}`,
            evidence: bad.slice(0, 5).map((s) => `${s.date}: ${s.providerRole}`),
          }
        : { status: "pass", message: `All technicians are ${label}` };
    }
    if (str(p.when) === "bcaba_delegated_codes") {
      const delegated = ctx.sessions.some((s) => s.providerRole === "BCaBA");
      if (!delegated) return NA("No BCaBA-delegated services");
      const { present } = documentPresent(str(p.requires) ?? "BCaBA attestation", ctx);
      return present
        ? { status: "pass", message: "BCaBA attestation on file" }
        : { status: "fail", message: `${str(p.requires)} required` };
    }
    return guidance(p, "Staff credentials");
  },

  event_trigger(p, ctx) {
    const events = Array.isArray(p.events) ? (p.events as string[]) : [str(p.event) ?? ""];
    const derived = events.map((e) => derivedEvent(e, p, ctx));
    let event = events.find((e, i) => ctx.client.events.includes(e) || derived[i] === true);
    if (!event) {
      // Only an event the app records or can work out may be ruled out; any other is the BCBA's call.
      const knowable = events.every((e, i) => RECORDED_EVENTS.includes(e) || derived[i] === false);
      if (knowable) return NA(`Event "${events.join(" / ")}" has not occurred`);
      return guidance(p, `If "${events.join(" / ")}" applies`, ["event", "events"]);
    }
    event = event.replace(/_/g, " ");
    const req = str(p.requires) ?? "";
    if (!req) return guidance(p, `Event "${event}"`, ["event", "events"]);
    const { present, how } = documentPresent(req, ctx);
    if (present) return { status: "pass", message: `${req}: present`, evidence: [how] };
    return p.warn_only === true
      ? {
          status: "warn",
          message: `Event "${event}": ${req} recommended`,
          evidence: [str(p.recommendation) ?? ""].filter(Boolean),
        }
      : { status: "fail", message: `Event "${event}" requires: ${req}` };
  },

  plan_content(p, ctx) {
    const evidence: string[] = [];
    const must = Array.isArray(p.must_include) ? (p.must_include as string[]) : [];
    const known = Object.keys(p).filter(
      (k) => !["must_include", "must_include_if_applicable", "signed_by", "when"].includes(k),
    );
    const ifApplicable = Array.isArray(p.must_include_if_applicable)
      ? (p.must_include_if_applicable as string[])
      : [];
    const when = str(p.when);
    if (when === "reauth" && ctx.plan?.type !== "reauth" && ctx.authorization?.kind !== "reauth")
      return NA("Only required for reauthorization requests");
    if (when && when !== "reauth") return guidance(p, `Applies when ${when.replace(/_/g, " ")}`, ["when"]);
    if (!ctx.plan) {
      if (must.length || p.signed_by) return { status: "fail", message: "No plan yet", evidence: [] };
    }
    const missing: string[] = [];
    let manual = 0;
    for (const topic of must) {
      if (topic === "evaluation_date") {
        if (!ctx.plan?.includesEvaluationDate) missing.push("evaluation date");
        continue;
      }
      const keys = sectionsForTopic(topic, ctx.plan?.sections.map((s) => s.key) ?? []);
      if (!keys) {
        evidence.push(`Manual check: "${topic.replace(/_/g, " ")}"`);
        manual++;
        continue;
      }
      const ok = keys.every((k) => ctx.plan?.sections.some((s) => s.key === k && s.hasContent));
      if (!ok) missing.push(topic.replace(/_/g, " "));
    }
    if (p.signed_by === "BCBA" && !ctx.plan?.allApprovedByBcba) missing.push("BCBA approval/signature");
    for (const topic of ifApplicable) evidence.push(`If applicable: "${topic.replace(/_/g, " ")}"`);
    for (const k of known) evidence.push(`${k.replace(/_/g, " ")}: ${JSON.stringify(p[k])}`);
    if (missing.length)
      return { status: "fail", message: `Plan must include: ${missing.join(", ")}`, evidence };
    if (!must.length && !p.signed_by)
      return { status: "warn", message: "Plan content guidance (manual check)", evidence };
    if (manual || ifApplicable.length)
      return {
        status: "warn",
        message: "Required plan content present; some items need a manual check",
        evidence,
      };
    return { status: "pass", message: "Required plan content present", evidence };
  },

  submission_channel(p) {
    const parts = [str(p.channel), str(p.name), str(p.address)].filter(Boolean).join(" · ");
    const ev = [
      str(p.note),
      p.fallback ? `Fallback: ${p.fallback}` : null,
      Array.isArray(p.separate_requests)
        ? `Separate requests: ${(p.separate_requests as string[]).join(", ")}`
        : null,
      p.phone_review === false ? "No phone review" : null,
    ].filter(Boolean) as string[];
    return { status: "pass", message: `Submit via ${parts}`, evidence: ev };
  },

  decision_timeframe(p) {
    const parts = [
      num(p.standard_days) !== undefined ? `standard requests within ${p.standard_days} calendar days` : null,
      num(p.supplemental_documentation_days) !== undefined
        ? `${p.supplemental_documentation_days} more calendar days after supplemental documentation`
        : null,
      num(p.expedited_hours) !== undefined ? `expedited requests within ${p.expedited_hours} hours` : null,
    ].filter(Boolean);
    return {
      status: "pass",
      message: `Payor must decide ${parts.join(" and ")}`,
      evidence: [
        str(p.from) ? `Applies from ${p.from}` : "",
        "If no decision arrives in time, follow up and record the reference number",
      ].filter(Boolean),
    };
  },
};

export function evaluateRule(rule: Rule, ctx: EvalContext): RuleResult {
  const out = EVALUATORS[rule.type](rule.params, ctx, rule);
  const evidence = [...(out.evidence ?? [])];
  let status = out.status;
  // Why the rule can't be trusted yet (source changed, broken, expired, secondary only).
  if (rule.trust && rule.trust.status !== "verified") for (const r of rule.trust.reasons) evidence.push(r);
  if (!rule.verified) {
    // Unverified rules never block: they can only warn.
    if (status === "fail" || status === "pass") {
      evidence.push(
        status === "fail"
          ? "Would fail if verified. Rule is unverified: check the source."
          : "Rule is unverified: check the source.",
      );
      status = "warn";
    }
  }
  if (rule.notes) evidence.push(`Note: ${rule.notes}`);
  return { rule, status, rawStatus: out.status, message: out.message, evidence };
}

export function evaluateRules(rules: Rule[], ctx: EvalContext): RuleResult[] {
  return rules.map((r) => evaluateRule(r, ctx));
}
