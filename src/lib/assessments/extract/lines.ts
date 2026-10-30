/**
 * The common shape every imported file is turned into: lines of cells, each with a location a
 * BCBA can find in the original ("Skill areas!B4", "page 1, line 8", "OCR line 9", "line 12").
 * Plus the small, pure parsers the matcher uses: cell splitting, numbers, "x of y", and dates.
 *
 * Lines live in memory only while a file is read. Nothing here is stored or logged.
 */
import { dayToDate, toDay, type Day } from "../../dates";

export type Cell = {
  text: string;
  /** Where the cell is, e.g. "Skill areas!B4" or "page 1, line 8". */
  where: string;
  /** A spreadsheet number cell's value (text cells are parsed by the matcher). */
  num?: number;
  /** A spreadsheet date cell. */
  date?: Day;
  /** OCR word confidence (0-100), lowest of the cell's words. */
  conf?: number;
  /**
   * The column a spreadsheet or Word table cell is in (0-based). Empty cells are skipped, so
   * values are matched to a header by this, never by how many cells a row has.
   */
  col?: number;
};
export type Line = {
  where: string;
  cells: Cell[];
  /** The sheet, page, or table the line belongs to: a column header never carries across groups. */
  group?: string;
};

/**
 * Splits one line of text into cells: tabs, pipes, runs of 2+ spaces, dot leaders
 * ("Autism Composite ....... 63"), and "label: value".
 */
export function splitCells(text: string): string[] {
  return text
    .replace(/\u00a0/g, " ")
    .split(/\t|\s*\|\s*|\s{2,}|\s*(?:\.\s*){3,}\s*|(?<=[A-Za-z)\]])\s*:\s+|(?<=[A-Za-z)\]])\s*:$/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .flatMap(peelNumbers);
}

const NUM_TOKEN = String.raw`(?:\d+(?:[.,]\d+)?\s*(?:of|out of|/)\s*\d+(?:[.,]\d+)?|[<>≤≥]?\s*\d+(?:[.,]\d+)?%?|\d+-\d+)`;
const TRAILING_NUMBERS = new RegExp(String.raw`^(.*?[A-Za-z)\]])\s+((?:${NUM_TOKEN}\s*)+)$`, "i");

/** "Social Awareness 12 70" (single spaces, as OCR and plain text often have) → label, 12, 70. */
function peelNumbers(cell: string): string[] {
  const m = TRAILING_NUMBERS.exec(cell);
  if (!m || parseDay(cell) || parseOfPossible(cell)) return [cell];
  const nums = [...m[2]!.matchAll(new RegExp(NUM_TOKEN, "gi"))].map((x) => x[0].trim());
  return [m[1]!.trim(), ...nums];
}

/** A text line as cells, all sharing the line's location. */
export function textLine(text: string, where: string, group?: string): Line | null {
  const cells = splitCells(text).map((t) => ({ text: t, where }));
  return cells.length ? { where, cells, ...(group !== undefined ? { group } : {}) } : null;
}

const NUM = String.raw`\d{1,5}(?:[.,]\d+)?`;
const toNum = (s: string) => Number(s.replace(",", "."));

/** A plain number cell: "71", "71.5", "85%", "T = 74". Not a range, date, or "<1". */
export function parseNumber(text: string): number | null {
  const t = text.trim();
  const m = new RegExp(`^(?:[A-Za-z]{1,2}\\s*=\\s*)?(${NUM})\\s*%?$`).exec(t);
  return m ? toNum(m[1]!) : null;
}

/** "14 of 32", "14/32", "14 out of 32", "14 / 32 points". */
export function parseOfPossible(text: string): { value: number; possible: number } | null {
  const m = new RegExp(`^(${NUM})\\s*(?:/|of|out of)\\s*(${NUM})(?:\\s*(?:points?|items?|pts))?$`, "i").exec(
    text.trim(),
  );
  if (!m) return null;
  return { value: toNum(m[1]!), possible: toNum(m[2]!) };
}

/** A percentile written as a bound ("<1", "> 99", "<0.1"): never a number we can store. */
export const isBoundedNumber = (text: string) => new RegExp(`^[<>≤≥]\\s*${NUM}\\s*%?$`).test(text.trim());

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

function day(y: number, m: number, d: number): Day | null {
  if (y < 100) y += 2000;
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  const s = `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  const dt = dayToDate(s);
  return !Number.isNaN(dt.getTime()) && toDay(dt) === s ? s : null;
}

/** A date written as 2026-04-13, 04/13/2026 (US order), April 13, 2026, or 13 April 2026. */
export function parseDay(text: string): Day | null {
  const t = text.trim().replace(/\s+/g, " ");
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(t);
  if (m) return day(+m[1]!, +m[2]!, +m[3]!);
  m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2}|\d{4})$/.exec(t);
  if (m) return day(+m[3]!, +m[1]!, +m[2]!);
  m = /^([A-Za-z]{3,9})\.? (\d{1,2})(?:st|nd|rd|th)?,? (\d{4})$/.exec(t);
  if (m) {
    const mo = MONTHS.indexOf(m[1]!.slice(0, 3).toLowerCase());
    return mo < 0 ? null : day(+m[3]!, mo + 1, +m[2]!);
  }
  m = /^(\d{1,2}) ([A-Za-z]{3,9})\.?,? (\d{4})$/.exec(t);
  if (m) {
    const mo = MONTHS.indexOf(m[2]!.slice(0, 3).toLowerCase());
    return mo < 0 ? null : day(+m[3]!, mo + 1, +m[1]!);
  }
  return null;
}

/** The text of a whole line, for the PHI checks. */
export const lineText = (l: Line) => l.cells.map((c) => c.text).join("  ");
