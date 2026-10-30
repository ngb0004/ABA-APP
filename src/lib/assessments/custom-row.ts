/**
 * Live checks for a scale the BCBA adds by hand on the import review screen ("Other areas or
 * scales"). Pure and client-safe; the server validates again on confirm.
 */
export type CustomRowInput = { name: string; kind: string; value: string; possible: string };

/** True when nothing was typed: the row is ignored (and dropped on confirm). */
export const isBlankRow = (c: CustomRowInput) =>
  !c.name.trim() && !c.kind && !c.value.trim() && !c.possible.trim();

/** What a typed row still needs, or null when it is complete. Blank rows have no problem. */
export function customRowProblem(c: CustomRowInput): string | null {
  if (isBlankRow(c)) return null;
  if (!c.name.trim()) return "enter a name";
  if (!c.kind) return "choose the kind of score";
  if (c.value.trim() === "") return "enter a score";
  const v = Number(c.value);
  if (!Number.isFinite(v)) return "not a number";
  if (c.kind === "score_of_possible") {
    if (c.possible.trim() === "") return "enter the possible points";
    const p = Number(c.possible);
    if (!Number.isFinite(p) || p <= 0) return "possible must be more than 0";
    if (v < 0) return "below 0";
    if (v > p) return "more than possible";
  } else if (c.possible.trim() !== "") return "leave possible blank for this kind";
  return null;
}

/** Rows that will be saved: typed, and complete. */
export const completeRows = (rows: CustomRowInput[]) =>
  rows.filter((c) => !isBlankRow(c) && customRowProblem(c) === null);
