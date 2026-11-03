/** Sessions on the Records page are browsed one calendar month at a time ("YYYY-MM"). */

export type SessionMonth = { month: string; sessions: number; units: number };

const MONTH = /^(\d{4})-(0[1-9]|1[0-2])$/;

export const isMonth = (m: unknown): m is string => typeof m === "string" && MONTH.test(m);

/** The month to show: the requested one when it has sessions, else the latest month with sessions. */
export function pickMonth(months: SessionMonth[], requested: unknown): string | null {
  if (isMonth(requested) && months.some((m) => m.month === requested)) return requested;
  return [...months].sort((a, b) => b.month.localeCompare(a.month))[0]?.month ?? null;
}

/** First day of the month and first day of the next month, as UTC dates (sessions are date-only). */
export function monthRange(month: string): { start: Date; end: Date } {
  const m = MONTH.exec(month);
  if (!m) throw new Error(`Not a month: ${month}`);
  const y = Number(m[1]);
  const mo = Number(m[2]);
  return { start: new Date(Date.UTC(y, mo - 1, 1)), end: new Date(Date.UTC(y, mo, 1)) };
}

/** "October 2026". */
export function monthLabel(month: string): string {
  const { start } = monthRange(month);
  return start.toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });
}

/** The months before and after `month` that have sessions (for previous / next links). */
export function neighbours(
  months: SessionMonth[],
  month: string,
): { prev: string | null; next: string | null } {
  const sorted = months.map((m) => m.month).sort();
  const i = sorted.indexOf(month);
  return {
    prev: i > 0 ? sorted[i - 1]! : null,
    next: i >= 0 && i < sorted.length - 1 ? sorted[i + 1]! : null,
  };
}
