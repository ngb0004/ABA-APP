/**
 * Parsers for change logs payors publish inside their documents. Each returns
 * what the payor itself says changed, so staleness can be section-specific.
 */
export type RevisionRow = { date: string; section: string; description: string; change: string };

const US_DATE = /(\d{1,2})\/(\d{1,2})\/(\d{4})/;
export function usDateToIso(s: string): string | null {
  const m = US_DATE.exec(s);
  if (!m) return null;
  const d = new Date(Date.UTC(Number(m[3]), Number(m[1]) - 1, Number(m[2])));
  return d.getUTCMonth() === Number(m[1]) - 1 ? d.toISOString().slice(0, 10) : null;
}

/**
 * Georgia Medicaid policy manuals: a "Revision Record" table of
 * <date> <section> <description> <A|M|D> rows, ending with the note
 * "The revisions outlined in this Table...".
 */
export function parseGaRevisionRecord(text: string): RevisionRow[] {
  const t = text.replace(/\s+/g, " ");
  const end = t.search(/The revisions outlined in this Table/i);
  if (end < 0) return [];
  const start = t.lastIndexOf("Revision Record", end);
  const body = t.slice(start < 0 ? 0 : start, end);
  const rows: RevisionRow[] = [];
  const re =
    /(\d{1,2}\/\d{1,2}\/\d{4})\s+(Appendix\s+[A-Z]{1,2}|\d{3}(?:\.\d+)*)\s+(.+?)\s+([AMD])(?=\s+\d{1,2}\/\d{1,2}\/\d{4}|\s*\d*\s*$)/g;
  for (const m of body.matchAll(re)) {
    const date = usDateToIso(m[1]!);
    if (date)
      rows.push({ date, section: m[2]!.replace(/\s+/g, " "), description: m[3]!.trim(), change: m[4]! });
  }
  return rows;
}

/** Georgia manuals are re-posted quarterly: the next revision is the next quarter start. */
export function nextQuarterStart(isoDate: string): string {
  const [y, m] = isoDate.split("-").map(Number) as [number, number];
  const q = Math.floor((m - 1) / 3) + 1;
  return q === 4 ? `${y + 1}-01-01` : `${y}-${String(q * 3 + 1).padStart(2, "0")}-01`;
}

/** Aetna Clinical Policy Bulletins show "Last Review MM/DD/YYYY" and "Next Review: MM/DD/YYYY". */
export function parseAetnaCpbDates(text: string): { lastReview: string | null; nextReview: string | null } {
  const t = text.replace(/\s+/g, " ");
  const last = /Last Review:?\s*(\d{1,2}\/\d{1,2}\/\d{4})/i.exec(t);
  const next = /Next Review:?\s*(\d{1,2}\/\d{1,2}\/\d{4})/i.exec(t);
  return { lastReview: last ? usDateToIso(last[1]!) : null, nextReview: next ? usDateToIso(next[1]!) : null };
}
