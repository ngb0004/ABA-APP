/**
 * Finds every written form of one calendar date in free text, by parsing each date-shaped string
 * and comparing values, not by comparing a few fixed spellings. Used to remove a date of birth
 * before an AI call and to refuse a prompt that still holds one.
 */

const MONTHS = [
  "january",
  "february",
  "march",
  "april",
  "may",
  "june",
  "july",
  "august",
  "september",
  "october",
  "november",
  "december",
];
const MONTH_RE =
  "(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\\.?";
const monthOf = (s: string) =>
  MONTHS.findIndex((m) => m.startsWith(s.toLowerCase().replace(".", "").slice(0, 3))) + 1;

type Ymd = { y: number; m: number; d: number };

function year(s: string, target: number): number {
  const n = Number(s);
  if (s.length === 4) return n;
  // Two-digit year: the century that puts it closest to the target year.
  const base = Math.floor(target / 100) * 100;
  const cands = [base - 100 + n, base + n, base + 100 + n];
  return cands.reduce((a, b) => (Math.abs(b - target) < Math.abs(a - target) ? b : a));
}

const PATTERNS: { re: RegExp; parse: (m: RegExpExecArray, t: Ymd) => Ymd[] }[] = [
  // 2019-03-04, 2019/3/4, 2019.03.04
  {
    re: /(?<!\d)(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?!\d)/g,
    parse: (m) => [{ y: Number(m[1]), m: Number(m[2]), d: Number(m[3]) }],
  },
  // 03/04/2019, 3-4-19, 04.03.2019: read both month-first and day-first.
  {
    re: /(?<!\d)(\d{1,2})[-/.](\d{1,2})[-/.](\d{4}|\d{2})(?!\d)/g,
    parse: (m, t) => {
      const y = year(m[3]!, t.y);
      return [
        { y, m: Number(m[1]), d: Number(m[2]) },
        { y, m: Number(m[2]), d: Number(m[1]) },
      ];
    },
  },
  // March 4, 2019 / Mar. 4th 2019
  {
    re: new RegExp(`\\b${MONTH_RE}\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s+(\\d{4}|'?\\d{2})(?!\\d)`, "gi"),
    parse: (m, t) => [{ y: year(m[3]!.replace("'", ""), t.y), m: monthOf(m[1]!), d: Number(m[2]) }],
  },
  // 4 March 2019 / 4th of March, 2019
  {
    re: new RegExp(
      `(?<!\\d)(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?${MONTH_RE},?\\s+(\\d{4}|'?\\d{2})(?!\\d)`,
      "gi",
    ),
    parse: (m, t) => [{ y: year(m[3]!.replace("'", ""), t.y), m: monthOf(m[2]!), d: Number(m[1]) }],
  },
  // 20190304
  {
    re: /(?<!\d)(\d{4})(\d{2})(\d{2})(?!\d)/g,
    parse: (m) => [{ y: Number(m[1]), m: Number(m[2]), d: Number(m[3]) }],
  },
];

function parseIso(iso: string): Ymd | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  return m ? { y: Number(m[1]), m: Number(m[2]), d: Number(m[3]) } : null;
}

/** Every substring of `text` that writes the date `iso` (YYYY-MM-DD), in any common format. */
export function findDate(text: string, iso: string): string[] {
  const t = parseIso(iso);
  if (!t) return text.includes(iso) ? [iso] : [];
  const hits: string[] = [];
  for (const p of PATTERNS) {
    p.re.lastIndex = 0;
    for (let m = p.re.exec(text); m; m = p.re.exec(text))
      if (p.parse(m, t).some((c) => c.y === t.y && c.m === t.m && c.d === t.d)) hits.push(m[0]);
  }
  return [...new Set(hits)].sort((a, b) => b.length - a.length);
}

/** Replaces every written form of the date `iso` with `tag`. */
export function redactDate(text: string, iso: string, tag: string): string {
  let out = text;
  for (const h of findDate(text, iso)) out = out.split(h).join(tag);
  return out;
}

/** US phone and fax numbers: (404) 555-0100, 404-555-0100, 404.555.0100, +1 404 555 0100. */
export const PHONE_RE = /(?<!\d)(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}(?!\d)/g;
