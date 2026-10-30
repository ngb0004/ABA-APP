/**
 * PHI-looking content in an imported score file: a labelled name, a date of birth, or a member,
 * record, or similar ID. Only which kinds were found (and on which lines) is returned, never the
 * values. Lines with PHI are left out of score, date, form, and respondent matching.
 */
import { normalizeLabel } from "../catalog";
import { looksLikeClientRecord } from "../../rules-watch/text";
import { lineText, type Line } from "./lines";

export type PhiFound = { name: boolean; dob: boolean; memberId: boolean };

const NAME_LABELS = new Set(
  [
    "name",
    "full name",
    "first name",
    "last name",
    "child",
    "child name",
    "client",
    "client name",
    "patient",
    "patient name",
    "examinee",
    "examinee name",
    "student",
    "student name",
    "learner",
    "learner name",
    "individual",
    "individual name",
    "name of child",
    "name of client",
  ].map(normalizeLabel),
);
const BIRTH = /\b(?:dob|d\s?o\s?b|date of birth|birth ?date|birthday|born)\b/;
const ID_LABEL =
  /^(?:(?:member|subscriber|medicaid|medicare|insurance|policy|patient|client|medical record|record|case|chart|student|social security) (?:id|number|no|num)|mrn|ssn|id|policy)$/;
const ID_SHAPES = [/\bSYN-[A-Z0-9-]+/i, /\b[A-Z]{1,4}-?\d{6,}\b/i, /\b\d{8,}\b/, /\b\d{3}-\d{2}-\d{4}\b/];

/** A value that is really there: letters or digits, not "____", "N/A", or "[withheld]". */
const filled = (s: string | undefined) => {
  if (!s) return false;
  const t = s.trim();
  if (/^[_\-\s.]*$/.test(t) || /^\(?\[?(?:n\/?a|none|withheld|redacted|removed)\]?\)?$/i.test(t))
    return false;
  return /[A-Za-z0-9]/.test(t);
};

/** Which PHI kinds appear on one line. */
export function phiOnLine(line: Line): PhiFound {
  const found: PhiFound = { name: false, dob: false, memberId: false };
  const cells = line.cells;
  cells.forEach((c, i) => {
    const label = normalizeLabel(c.text);
    const next = cells[i + 1]?.text;
    if (NAME_LABELS.has(label) && filled(next) && /[A-Za-z]{2}/.test(next!)) found.name = true;
    if (BIRTH.test(label) && (filled(next) || /\d/.test(c.text))) found.dob = true;
    if (ID_LABEL.test(label) && filled(next) && /\d/.test(next!)) found.memberId = true;
  });
  const text = lineText(line);
  if (ID_SHAPES.some((re) => re.test(text))) found.memberId = true;
  if (!found.name && !found.dob && looksLikeClientRecord(text.replace(/\s{2,}/g, ": "))) found.name = true;
  return found;
}

/** PHI kinds found anywhere in the file, and the indexes of the lines that carry them. */
export function detectPhi(lines: Line[]): { phi: PhiFound; lines: Set<number>; where: string[] } {
  const phi: PhiFound = { name: false, dob: false, memberId: false };
  const hit = new Set<number>();
  const where: string[] = [];
  lines.forEach((l, i) => {
    const f = phiOnLine(l);
    if (f.name || f.dob || f.memberId) {
      hit.add(i);
      where.push(l.where);
    }
    phi.name ||= f.name;
    phi.dob ||= f.dob;
    phi.memberId ||= f.memberId;
  });
  return { phi, lines: hit, where };
}
