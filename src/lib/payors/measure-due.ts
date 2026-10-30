/**
 * When an outcome measure or reassessment is due (BCBA answer, QUESTIONS #44): "30 days before
 * the authorization ends". Pure date math, unit tested.
 *
 * With a current authorization (one that has not ended), a measure is due for the coming
 * reauthorization when its cadence would lapse before the next authorization starts
 * (last given + cadence < authorization end + 1 day), and it is due by the authorization's end
 * minus N days (N is the practice setting "Assessments due before authorization ends").
 * Overdue means today is after that date. Without a current authorization the cadence date is
 * used: due by last given + cadence, overdue once that has passed.
 */
import { addDays, addMonths, type Day } from "../dates";

/** The practice setting's default (Settings: "Assessments due before authorization ends"). */
export const DEFAULT_ASSESSMENT_DUE_DAYS = 30;

/** The practice's setting from stored org settings, or the default when missing or malformed. */
export function assessmentDueDaysOf(settings: unknown): number {
  const v = (settings as { assessmentDueDays?: unknown } | null)?.assessmentDueDays;
  return typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= 120 ? v : DEFAULT_ASSESSMENT_DUE_DAYS;
}

export type DueAuthorization = { startDate: Day; endDate: Day };

/** The authorization the coming reauthorization follows: the latest one, while it has not ended. */
export function currentAuthorization<T extends DueAuthorization>(
  auth: T | null | undefined,
  asOf: Day,
): T | null {
  return auth && auth.endDate >= asOf ? auth : null;
}

export type MeasureDueInput = {
  /** The newest administration on record, or null when never given. */
  lastGiven: Day | null;
  cadenceMonths: number;
  /** The current authorization (see currentAuthorization), or null. */
  authorization: DueAuthorization | null;
  asOf: Day;
  /** Days before the authorization ends that assessments are due (practice setting). */
  daysBefore: number;
};

export type MeasureDue = {
  basis: "authorization" | "cadence";
  lastGiven: Day | null;
  /** last given + cadence: the day the measure stops being current. */
  lapses: Day | null;
  /** Due now or for the coming reauthorization. */
  due: boolean;
  /** Authorization basis: end − N days when due. Cadence basis: the lapse date. */
  dueBy: Day | null;
  overdue: boolean;
  authEnd: Day | null;
  daysBefore: number;
};

export function measureDue(i: MeasureDueInput): MeasureDue {
  const lapses = i.lastGiven ? addMonths(i.lastGiven, i.cadenceMonths) : null;
  const base = { lastGiven: i.lastGiven, lapses, daysBefore: i.daysBefore };
  if (i.authorization) {
    const end = i.authorization.endDate;
    const nextStart = addDays(end, 1);
    const due = !lapses || lapses < nextStart;
    const dueBy = due ? addDays(end, -i.daysBefore) : null;
    return { ...base, basis: "authorization", due, dueBy, overdue: !!dueBy && i.asOf > dueBy, authEnd: end };
  }
  // No current authorization: current while its cadence date has not passed.
  const overdue = !!lapses && lapses < i.asOf;
  return { ...base, basis: "cadence", due: !lapses || overdue, dueBy: lapses, overdue, authEnd: null };
}

const days = (n: number) => `${n} ${n === 1 ? "day" : "days"}`;

/**
 * "Vineland-3 last given 2026-04-12 · due by 2026-10-10 (30 days before the authorization ends
 * 2026-11-09)". Null when there is nothing to date (never given, no current authorization).
 */
export function measureDueLine(label: string, d: MeasureDue): string | null {
  const given = d.lastGiven ? `${label} last given ${d.lastGiven}` : `${label} not given yet`;
  if (d.basis === "authorization") {
    if (!d.due) return `${given} · next due ${d.lapses}, after the authorization ends ${d.authEnd}`;
    const why = `(${days(d.daysBefore)} before the authorization ends ${d.authEnd})`;
    return `${given} · ${d.overdue ? "overdue since" : "due by"} ${d.dueBy} ${why}`;
  }
  if (!d.dueBy) return null;
  return `${given} · ${d.overdue ? "overdue since" : "due by"} ${d.dueBy}`;
}

/** The short form for a rule's message: "due by 2026-10-10" or "overdue since 2026-10-10". */
export function measureDueShort(d: MeasureDue): string | null {
  if (!d.dueBy) return null;
  return `${d.overdue ? "overdue since" : "due by"} ${d.dueBy}`;
}
