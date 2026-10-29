/**
 * Supervision metrics per calendar month: direct (97153) and supervision
 * (97155) hours, in-person supervision sessions, and per-technician ratios.
 * Payor thresholds come from payor_rule params, never from code.
 */
import { monthKey, type Day } from "./dates";

export type SupervisionSession = {
  cptCode: string;
  date: Day;
  units: number;
  inPerson: boolean;
  providerId?: string | null;
  providerRole?: string | null;
};

export type MonthSupervision = {
  month: string;
  directHours: number;
  supervisionHours: number;
  inPersonSupervisionHours: number;
  inPersonSupervisionSessions: number;
  /** supervision hours ÷ direct hours, or null when no direct hours */
  ratio: number | null;
  perTechnician: {
    providerId: string;
    directHours: number;
    supervisionHours: number;
    ratio: number | null;
  }[];
};

export const DIRECT_CODE = "97153";
export const SUPERVISION_CODE = "97155";

const hours = (units: number) => units / 4;
const r3 = (n: number) => Math.round(n * 1000) / 1000;

/** Only complete months (fully inside [start, asOf]) are returned unless includePartial. */
export function supervisionByMonth(
  sessions: SupervisionSession[],
  range: { start: Day; end: Day; asOf: Day },
  opts: { includePartial?: boolean } = {},
): MonthSupervision[] {
  const last = range.asOf < range.end ? range.asOf : range.end;
  const inRange = sessions.filter((s) => s.date >= range.start && s.date <= last);
  const months = [...new Set(inRange.map((s) => monthKey(s.date)))].sort();
  return months
    .filter((m) => {
      if (opts.includePartial) return true;
      const [y, mo] = m.split("-").map(Number) as [number, number];
      const monthEnd = new Date(Date.UTC(y, mo, 0)).toISOString().slice(0, 10);
      return `${m}-01` >= range.start && monthEnd <= last;
    })
    .map((month) => {
      const ms = inRange.filter((s) => monthKey(s.date) === month);
      const direct = ms.filter((s) => s.cptCode === DIRECT_CODE);
      const sup = ms.filter((s) => s.cptCode === SUPERVISION_CODE);
      const directHours = hours(direct.reduce((t, s) => t + s.units, 0));
      const supervisionHours = hours(sup.reduce((t, s) => t + s.units, 0));
      const inPerson = sup.filter((s) => s.inPerson);
      // Supervision is attributed to a technician when it overlaps their direct session date.
      const techs = [...new Set(direct.map((s) => s.providerId ?? "unknown"))];
      const perTechnician = techs.map((providerId) => {
        const td = direct.filter((s) => (s.providerId ?? "unknown") === providerId);
        const tdDates = new Set(td.map((s) => s.date));
        const dh = hours(td.reduce((t, s) => t + s.units, 0));
        const sh = hours(sup.filter((s) => tdDates.has(s.date)).reduce((t, s) => t + s.units, 0));
        return { providerId, directHours: dh, supervisionHours: sh, ratio: dh > 0 ? r3(sh / dh) : null };
      });
      return {
        month,
        directHours,
        supervisionHours,
        inPersonSupervisionHours: hours(inPerson.reduce((t, s) => t + s.units, 0)),
        inPersonSupervisionSessions: inPerson.length,
        ratio: directHours > 0 ? r3(supervisionHours / directHours) : null,
        perTechnician,
      };
    });
}
