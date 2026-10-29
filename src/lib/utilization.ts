/**
 * Delivered vs approved units per CPT code per week, with under-delivery
 * (< 80%) and over-delivery (> 100%) flags. Units are 15-minute CPT units.
 */
import { addDays, diffDays, type Day } from "./dates";

export type UnitBasis = "week" | "month" | "auth";
export type ApprovedUnit = { cptCode: string; approvedUnits: number; unitBasis: UnitBasis };
export type DeliveredSession = { cptCode: string; date: Day; units: number };

export const UNDER_DELIVERY_THRESHOLD = 0.8;
const WEEKS_PER_MONTH = 52 / 12;

export function authWeeks(start: Day, end: Day): number {
  return (diffDays(end, start) + 1) / 7;
}

/** Approved units expressed per week, for comparison with weekly delivery. */
export function approvedPerWeek(u: ApprovedUnit, start: Day, end: Day): number {
  if (u.unitBasis === "week") return u.approvedUnits;
  if (u.unitBasis === "month") return u.approvedUnits / WEEKS_PER_MONTH;
  return u.approvedUnits / authWeeks(start, end);
}

/** Total units approved over the whole authorization. */
export function approvedTotal(u: ApprovedUnit, start: Day, end: Day): number {
  if (u.unitBasis === "auth") return u.approvedUnits;
  return approvedPerWeek(u, start, end) * authWeeks(start, end);
}

export type WeekRow = {
  weekStart: Day;
  weekEnd: Day;
  delivered: number;
  approved: number;
  pct: number;
  flag: "under" | "over" | null;
};
export type CodeUtilization = {
  cptCode: string;
  unitBasis: UnitBasis;
  approvedPerWeek: number;
  approvedTotal: number;
  deliveredToDate: number;
  /** Approved units prorated to the end of the last complete week. */
  expectedToDate: number;
  pctToDate: number | null;
  flag: "under" | "over" | null;
  weeks: WeekRow[];
};

const r2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Weeks run from the authorization start in 7-day blocks. Only weeks completed by
 * asOf are flagged; per-auth codes (e.g., assessment) are only flagged for over-delivery.
 */
export function computeUtilization(
  auth: { startDate: Day; endDate: Day; units: ApprovedUnit[] },
  sessions: DeliveredSession[],
  asOf: Day,
): CodeUtilization[] {
  const { startDate: start, endDate: end } = auth;
  const lastDay = asOf < end ? asOf : end;
  const completeWeeks = Math.max(0, Math.floor((diffDays(lastDay, start) + 1) / 7));
  return auth.units.map((u) => {
    const perWeek = approvedPerWeek(u, start, end);
    const inAuth = sessions.filter(
      (s) => s.cptCode === u.cptCode && s.date >= start && s.date <= end && s.date <= asOf,
    );
    const weeks: WeekRow[] = [];
    for (let w = 0; w < completeWeeks; w++) {
      const ws = addDays(start, w * 7);
      const we = addDays(ws, 6);
      const delivered = inAuth.filter((s) => s.date >= ws && s.date <= we).reduce((t, s) => t + s.units, 0);
      const pct = perWeek > 0 ? delivered / perWeek : 0;
      const flag =
        u.unitBasis === "auth" ? null : pct < UNDER_DELIVERY_THRESHOLD ? "under" : pct > 1 ? "over" : null;
      weeks.push({ weekStart: ws, weekEnd: we, delivered, approved: r2(perWeek), pct: r2(pct), flag });
    }
    const deliveredToDate = inAuth.reduce((t, s) => t + s.units, 0);
    const total = approvedTotal(u, start, end);
    const expected = u.unitBasis === "auth" ? total : perWeek * completeWeeks;
    const pctToDate = expected > 0 ? deliveredToDate / expected : null;
    let flag: "under" | "over" | null = null;
    if (deliveredToDate > total) flag = "over";
    else if (u.unitBasis !== "auth" && pctToDate !== null && completeWeeks > 0) {
      flag = pctToDate < UNDER_DELIVERY_THRESHOLD ? "under" : pctToDate > 1 ? "over" : null;
    }
    return {
      cptCode: u.cptCode,
      unitBasis: u.unitBasis,
      approvedPerWeek: r2(perWeek),
      approvedTotal: r2(total),
      deliveredToDate,
      expectedToDate: r2(expected),
      pctToDate: pctToDate === null ? null : r2(pctToDate),
      flag,
      weeks,
    };
  });
}
