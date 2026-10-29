/** Goal progress metrics from session data: baseline, current, flat detection, data gaps. */
import { diffDays, type Day } from "../dates";

export type Point = { date: Day; value: number };

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);

export function baseline(points: Point[], n = 3): number | null {
  const s = [...points].sort((a, b) => a.date.localeCompare(b.date)).slice(0, n);
  return s.length ? Math.round(mean(s.map((p) => p.value)) * 10) / 10 : null;
}

export function current(points: Point[], n = 3): number | null {
  const s = [...points].sort((a, b) => a.date.localeCompare(b.date)).slice(-n);
  return s.length ? Math.round(mean(s.map((p) => p.value)) * 10) / 10 : null;
}

/** Least-squares slope in value units per week. */
export function slopePerWeek(points: Point[]): number | null {
  if (points.length < 3) return null;
  const t0 = points[0]!.date;
  const xs = points.map((p) => diffDays(p.date, t0) / 7);
  const ys = points.map((p) => p.value);
  const mx = mean(xs);
  const my = mean(ys);
  let num = 0;
  let den = 0;
  for (let i = 0; i < xs.length; i++) {
    num += (xs[i]! - mx) * (ys[i]! - my);
    den += (xs[i]! - mx) ** 2;
  }
  return den === 0 ? null : num / den;
}

export const FLAT_WEEKS = 8;
/** Percent goals: projected change under 5 points over 8 weeks is flat. Frequency goals: under a 10% decrease. */
export function flatProgress(
  points: Point[],
  measure: string,
  asOf: Day,
  weeks = FLAT_WEEKS,
): { flat: boolean; projectedChange: number | null } {
  const recent = points
    .filter((p) => diffDays(asOf, p.date) <= weeks * 7)
    .sort((a, b) => a.date.localeCompare(b.date));
  const slope = slopePerWeek(recent);
  if (slope === null) return { flat: false, projectedChange: null };
  const change = slope * weeks;
  if (measure === "percent") return { flat: change < 5, projectedChange: Math.round(change * 10) / 10 };
  const level = mean(recent.map((p) => p.value));
  return { flat: level > 0 ? -change / level < 0.1 : false, projectedChange: Math.round(change * 10) / 10 };
}

export const MAX_GAP_DAYS = 7;
export function dataGaps(points: Point[], maxGap = MAX_GAP_DAYS): { from: Day; to: Day; days: number }[] {
  const s = [...points].sort((a, b) => a.date.localeCompare(b.date));
  const gaps = [];
  for (let i = 1; i < s.length; i++) {
    const days = diffDays(s[i]!.date, s[i - 1]!.date);
    if (days > maxGap) gaps.push({ from: s[i - 1]!.date, to: s[i]!.date, days });
  }
  return gaps;
}
