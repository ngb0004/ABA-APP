/**
 * Caseload calendar: everything due in the next N days, and auth-end alerts.
 * Dates come from authorizations and payor rule params; defaults (e.g., when to
 * target a reauth submission) are per-org settings with safe fallbacks.
 */
import { addDays, addMonths, diffDays, type Day } from "./dates";
import type { Rule } from "./payors/types";

export type CalendarEvent = {
  date: Day;
  clientId: string;
  kind:
    | "auth_expiration"
    | "reauth_submission_target"
    | "reauth_window_opens"
    | "reassessment_due"
    | "assessment_request_due"
    | "outcome_measures_due"
    | "auth_alert";
  label: string;
  /** Rule that produced this event, when payor-driven. */
  ruleId?: string;
  verified?: boolean;
};

export type CalendarSettings = {
  /** Days before auth end to target a reauth submission (org setting). */
  reauthLeadDays: number;
  /** Days before auth end that the reassessment should be completed. */
  reassessmentLeadDays: number;
  alertDays: number[];
};

export const DEFAULT_CALENDAR_SETTINGS: CalendarSettings = {
  reauthLeadDays: 30,
  reassessmentLeadDays: 45,
  alertDays: [30, 21, 14],
};

export type CalendarAuth = {
  clientId: string;
  authNumber: string;
  startDate: Day;
  endDate: Day;
  kind: "initial" | "reauth";
  rules: Rule[];
};

export function authEvents(
  a: CalendarAuth,
  settings: CalendarSettings = DEFAULT_CALENDAR_SETTINGS,
): CalendarEvent[] {
  const ev: CalendarEvent[] = [];
  const { clientId, endDate: end } = a;
  ev.push({ date: end, clientId, kind: "auth_expiration", label: `Authorization ${a.authNumber} ends` });

  let target = addDays(end, -settings.reauthLeadDays);
  for (const r of a.rules.filter((x) => x.type === "request_timing")) {
    const p = r.params;
    if (typeof p.submit_up_to_days_before_auth_end === "number") {
      const opens = addDays(end, -p.submit_up_to_days_before_auth_end);
      ev.push({
        date: opens,
        clientId,
        kind: "reauth_window_opens",
        label: `Reauth submission window opens`,
        ruleId: r.id,
        verified: r.verified,
      });
      if (target < opens) target = opens;
    }
    if (typeof p.months_before_auth_end === "number") {
      ev.push({
        date: addMonths(end, -p.months_before_auth_end),
        clientId,
        kind: "assessment_request_due",
        label: `${String(p.code ?? "Assessment")} request due${p.separate_request ? " (separate request)" : ""}`,
        ruleId: r.id,
        verified: r.verified,
      });
    }
  }
  ev.push({ date: target, clientId, kind: "reauth_submission_target", label: "Reauth submission target" });
  ev.push({
    date: addDays(end, -settings.reassessmentLeadDays),
    clientId,
    kind: "reassessment_due",
    label: "Reassessment due",
  });

  // Outcome measures: completed early enough that the report is ready by the submission target.
  for (const r of a.rules.filter((x) => x.type === "outcome_measure_schedule")) {
    const timing = a.rules.find(
      (x) => x.type === "request_timing" && typeof x.params.report_due_days_after_assessment === "number",
    );
    const reportDays = timing ? (timing.params.report_due_days_after_assessment as number) : 0;
    const list = (a.kind === "initial" ? r.params.initial : r.params.every_6_months) as string[] | undefined;
    if (list?.length)
      ev.push({
        date: addDays(target, -reportDays),
        clientId,
        kind: "outcome_measures_due",
        label: `Outcome measures due: ${list.join(", ").replace(/_/g, " ")}`,
        ruleId: r.id,
        verified: r.verified,
      });
  }

  for (const d of settings.alertDays)
    ev.push({
      date: addDays(end, -d),
      clientId,
      kind: "auth_alert",
      label: `${d} days until authorization ends`,
    });
  return ev;
}

/** Events within [asOf, asOf + days], sorted by date. */
export function caseloadCalendar(
  auths: CalendarAuth[],
  asOf: Day,
  days = 60,
  settings: CalendarSettings = DEFAULT_CALENDAR_SETTINGS,
): CalendarEvent[] {
  const until = addDays(asOf, days);
  return auths
    .flatMap((a) => authEvents(a, settings))
    .filter((e) => e.date >= asOf && e.date <= until)
    .sort((x, y) => x.date.localeCompare(y.date) || x.kind.localeCompare(y.kind));
}

export type AuthAlert = { level: number; daysLeft: number; message: string };

/** The most urgent alert threshold reached (30, 21, 14 days before auth end). */
export function authEndAlert(
  endDate: Day,
  asOf: Day,
  settings: CalendarSettings = DEFAULT_CALENDAR_SETTINGS,
): AuthAlert | null {
  const daysLeft = diffDays(endDate, asOf);
  const days = (n: number) => `${n} ${n === 1 ? "day" : "days"}`;
  if (daysLeft < 0) return { level: 0, daysLeft, message: `Authorization ended ${days(-daysLeft)} ago` };
  const reached = [...settings.alertDays].sort((a, b) => a - b).find((d) => daysLeft <= d);
  return reached === undefined
    ? null
    : {
        level: reached,
        daysLeft,
        message:
          daysLeft === 0
            ? `Authorization ends today (${reached}-day alert)`
            : `${days(daysLeft)} until authorization ends (${reached}-day alert)`,
      };
}
