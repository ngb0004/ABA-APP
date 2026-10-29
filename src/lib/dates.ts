/** Date-only helpers. All dates are UTC calendar days ("YYYY-MM-DD"). */
export type Day = string;
const MS = 86_400_000;

export const toDay = (d: Date | string): Day =>
  typeof d === "string" ? d.slice(0, 10) : d.toISOString().slice(0, 10);
export const dayToDate = (d: Day): Date => new Date(`${d}T00:00:00Z`);
export const addDays = (d: Day, n: number): Day => toDay(new Date(dayToDate(d).getTime() + n * MS));
export const diffDays = (a: Day, b: Day): number =>
  Math.round((dayToDate(a).getTime() - dayToDate(b).getTime()) / MS);
export function addMonths(d: Day, n: number): Day {
  const dt = dayToDate(d);
  const target = new Date(Date.UTC(dt.getUTCFullYear(), dt.getUTCMonth() + n, 1));
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(dt.getUTCDate(), lastDay));
  return toDay(target);
}
export const monthKey = (d: Day) => d.slice(0, 7);
export const weekday = (d: Day) => dayToDate(d).getUTCDay(); // 0 = Sunday
export function ageYears(dob: Day, on: Day): number {
  const a = dayToDate(dob);
  const b = dayToDate(on);
  let age = b.getUTCFullYear() - a.getUTCFullYear();
  if (
    b.getUTCMonth() < a.getUTCMonth() ||
    (b.getUTCMonth() === a.getUTCMonth() && b.getUTCDate() < a.getUTCDate())
  )
    age--;
  return age;
}
