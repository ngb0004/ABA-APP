/**
 * Parsers for change logs payors publish inside their documents. Each returns
 * what the payor itself says changed, so staleness can be section-specific.
 */
/** section is null when the row's section could not be read: callers must treat it as touching every section. */
export type RevisionRow = { date: string; section: string | null; description: string; change: string };

const US_DATE = /(\d{1,2})\/(\d{1,2})\/(\d{4})/;
export function usDateToIso(s: string): string | null {
  const m = US_DATE.exec(s);
  if (!m) return null;
  const d = new Date(Date.UTC(Number(m[3]), Number(m[1]) - 1, Number(m[2])));
  return d.getUTCMonth() === Number(m[1]) - 1 ? d.toISOString().slice(0, 10) : null;
}

/** Revision-table dates: M/D/YYYY, MM/YYYY (first of the month), and a 5-digit typo year like 20206 (read as 2026). */
function tableDate(tok: string): string | null {
  const parts = tok.split("/");
  const [m, d, rawYear] =
    parts.length === 2 ? [parts[0]!, "1", parts[1]!] : (parts as [string, string, string]);
  const y =
    rawYear.length === 5 && rawYear.startsWith("202")
      ? `${rawYear.slice(0, 3)}${rawYear.slice(-1)}`
      : rawYear;
  return usDateToIso(`${m}/${d}/${y}`);
}

const APPENDIX_LIST = /^Appendi(?:x|ces)\s+([A-Z](?:\s*,\s*[A-Z])*(?:\s*,?\s*and\s+[A-Z])?)(?![a-z])/;
const NUMBERED = /^\d{3}(?:\.\d+)*/;

/**
 * Reads the section column at the start of a row. Handles "Section 601.1.2",
 * "Below 803.11", "Second Paragraph Following 804.12", "Appendix E, Section B (viii)",
 * "Appendix E(B)(vii)", "Appendices B, C, and D", and "602.2 and Appendix A- Location Code".
 * Returns sections as "A/B" (matching splits on "/") plus the rest of the text.
 */
function readSection(text: string): { section: string | null; rest: string } {
  let t = text.replace(/^(?:Second Paragraph Following|Following|Below|Section)\s+/i, "");
  const sections: string[] = [];
  for (let guard = 0; guard < 4; guard++) {
    const app = APPENDIX_LIST.exec(t);
    const num = NUMBERED.exec(t);
    if (app) {
      for (const letter of app[1]!.split(/\s*(?:,|and)\s*/).filter(Boolean))
        sections.push(`Appendix ${letter.trim()}`);
      t = t.slice(app[0].length);
      // Sub-parts that belong to the section column: ", Section B (viii)", "(B)(vii)", "- Location Code"
      t = t
        .replace(/^\s*(?:,\s*)?(?:Section\s+[A-Z](?:\s*\([^)]*\))*|\([A-Za-z]+\)(?:\([^)]*\))*)/, "")
        .replace(/^\s*[\u2013-]\s*Location Code/, "");
    } else if (num) {
      sections.push(num[0]);
      t = t.slice(num[0].length);
    } else break;
    const more = /^\s*(?:,|and|&)\s*(?=Appendi|\d{3})/.exec(t);
    if (!more) break;
    t = t.slice(more[0].length);
  }
  return {
    section: sections.length ? [...new Set(sections)].join("/") : null,
    rest: t.replace(/^\s*[,:\u2013-]?\s*/, ""),
  };
}

/**
 * Georgia Medicaid policy manuals: a "Revision Record" table whose rows are
 * <date> <section> <description> <change type>. Text extraction interleaves
 * page footers and wraps cells, so rows are split on their dates and parsed
 * leniently; a row whose section cannot be read is kept with section = null.
 */
export function parseGaRevisionRecord(text: string): RevisionRow[] {
  const t = text.replace(/\s+/g, " ");
  const end = t.search(/The revisions outlined in this Table/i);
  if (end < 0) return [];
  const start = t.lastIndexOf("Revision Record", end);
  let body = t.slice(start < 0 ? 0 : start, end).replace(/Page \d+ of \d+/g, " ");
  const header = body.search(/Legislation, etc\.\)/i);
  if (header >= 0) body = body.slice(header + "Legislation, etc.)".length);
  const DATE = /(?:^|\s)(\d{1,2}\/\d{1,2}\/\d{4,5}|\d{1,2}\/\d{4})(?=\s)/g;
  const marks = [...body.matchAll(DATE)].map((m) => ({ tok: m[1]!, at: m.index! + m[0].indexOf(m[1]!) }));
  const rows: RevisionRow[] = [];
  marks.forEach((mk, i) => {
    const date = tableDate(mk.tok);
    if (!date) return;
    let chunk = body
      .slice(mk.at + mk.tok.length, i + 1 < marks.length ? marks[i + 1]!.at : body.length)
      .replace(/\s+/g, " ")
      .trim();
    chunk = chunk.replace(/\s+\d+$/, ""); // footnote marker at the very end of the table
    // The change type is a single capital letter, usually last, but text wrapping can push it into the description.
    let change = "";
    const tail = /\s([A-Z])$/.exec(chunk);
    if (tail) {
      change = tail[1]!;
      chunk = chunk.slice(0, tail.index).trim();
    } else {
      const inner = /\s([ADMR])\s/.exec(chunk);
      if (inner) {
        change = inner[1]!;
        chunk = `${chunk.slice(0, inner.index)} ${chunk.slice(inner.index + 3)}`.trim();
      }
    }
    const { section, rest } = readSection(chunk);
    rows.push({ date, section, description: rest || chunk, change });
  });
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
