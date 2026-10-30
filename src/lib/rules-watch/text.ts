/** Text normalization shared by snapshots, change detection, and quote checks. */
import { createHash } from "node:crypto";

export function normalizeText(s: string): string {
  return s
    .replace(/[‘’‛]/g, "'")
    .replace(/[“”‟]/g, '"')
    .replace(/[–—−]/g, "-")
    .replace(/ /g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export const textSha256 = (normalized: string) => createHash("sha256").update(normalized).digest("hex");

/** A quote counts when it appears in the document, ignoring case and spacing. */
export function quoteAppears(quote: string, documentText: string): boolean {
  const q = normalizeText(quote).toLowerCase();
  return q.length > 0 && normalizeText(documentText).toLowerCase().includes(q);
}

/**
 * Every number in the rule's parameters must appear in the quote that verifies it:
 * numeric values, and digit codes inside strings (e.g., CPT "97155"). Dates in strings
 * ("2026-01-01") are skipped because documents write dates in many forms.
 */
export function numbersMissingFromQuote(params: unknown, quote: string): string[] {
  const nums: string[] = [];
  const walk = (v: unknown) => {
    if (typeof v === "number" && Number.isFinite(v)) nums.push(String(v));
    else if (typeof v === "string" && !/^\d{4}-\d{2}-\d{2}$/.test(v))
      for (const m of v.matchAll(/\d{3,}/g)) nums.push(m[0]);
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === "object") Object.values(v).forEach(walk);
  };
  walk(params);
  const q = digitsForNumberWords(normalizeText(quote));
  // A whole number: not part of a longer number or the integer part of a decimal ("2" is not in "2.5").
  return [...new Set(nums)].filter(
    (n) => !new RegExp(`(^|[^\\d.])${n.replace(".", "\\.")}(?![\\d]|\\.\\d)`).test(q),
  );
}

const WORDS: Record<string, number> = {
  zero: 0,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
  thirteen: 13,
  fourteen: 14,
  fifteen: 15,
  sixteen: 16,
  seventeen: 17,
  eighteen: 18,
  nineteen: 19,
  twenty: 20,
  thirty: 30,
  forty: 40,
  fifty: 50,
  sixty: 60,
  seventy: 70,
  eighty: 80,
  ninety: 90,
};

/** Payors often spell numbers out ("one to two hours per ten hours", "six-month"); read them as digits for the number check. */
/** Credentials a rule enforces (must_be, must_be_any_of, supervised_by) that the quote does not name. */
export function credentialsMissingFromQuote(params: unknown, quote: string): string[] {
  const p = (params ?? {}) as Record<string, unknown>;
  const wanted = [p.must_be, p.must_be_any_of, p.supervised_by]
    .flatMap((v) => (Array.isArray(v) ? v : [v]))
    .filter((v): v is string => typeof v === "string" && /^[A-Za-z-]{2,12}$/.test(v));
  const q = normalizeText(quote);
  return [...new Set(wanted)].filter(
    (c) => !new RegExp(`(^|[^A-Za-z])${c.replace(/-/g, "\\-")}($|[^A-Za-z])`).test(q),
  );
}

export function digitsForNumberWords(text: string): string {
  return text
    .replace(
      /\b(twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety)[- ](one|two|three|four|five|six|seven|eight|nine)\b/gi,
      (_m, t: string, u: string) => String(WORDS[t.toLowerCase()]! + WORDS[u.toLowerCase()]!),
    )
    .replace(
      /\b(zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety)\b/gi,
      (w) => String(WORDS[w.toLowerCase()]),
    );
}

/** A quote must be real text: at least 4 words and 20 characters after normalization. */
export function quoteIsSubstantial(quote: string): boolean {
  const q = normalizeText(quote);
  return q.length >= 20 && q.split(" ").filter((w) => /[A-Za-z]{2,}/.test(w)).length >= 4;
}

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  "#39": "'",
};

export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style|noscript)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&(#\d+|#x[0-9a-f]+|[a-z]+);/gi, (m, e: string) => {
      if (e[0] === "#") {
        const code = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
        return Number.isFinite(code) ? String.fromCodePoint(code) : m;
      }
      return ENTITIES[e.toLowerCase()] ?? m;
    });
}

/**
 * Payor publications never carry a filled-in client record. An upload that does
 * (a letter, a filled-in form) is rejected before anything is stored.
 */
const CLIENT_RECORD_PATTERNS: RegExp[] = [
  /\b(?:date of birth|dob|birth ?date)\s*[:#]?\s*(?:\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4}|\d{4}-\d{1,2}-\d{1,2}|(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+\d{1,2},?\s+\d{4}|\d{1,2}\s+(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+\d{4})/i,
  /\b(?:member|subscriber|patient|beneficiary|client|medicaid)\s*(?:id|number|no\.?|#)\s*[:#]\s*[A-Z]{0,4}\d[A-Z0-9-]{5,}/i,
];
/** A name label (any case) followed by two words; the words are checked in code below. */
const NAME_LABEL =
  /\b(?:patient|client|member|beneficiary|child|subscriber|participant|student)(?:'?s)?\s*(?:full\s+)?name\s*:\s*([A-Za-z][A-Za-z'-]*)\s+([A-Za-z][A-Za-z'-]*)(\s*[:,])?/gi;
/** Words that start the next field of a blank form, never a person's name. */
const FORM_WORDS = new Set(
  "member patient client subscriber beneficiary parent guardian caregiver date birth dob id number no phone address signature gender sex age group plan policy last first middle name of the and or".split(
    " ",
  ),
);
const looksLikeName = (w: string) => /^[A-Z]/.test(w) && !FORM_WORDS.has(w.toLowerCase());

export function looksLikeClientRecord(text: string): boolean {
  const t = normalizeText(text);
  if (CLIENT_RECORD_PATTERNS.some((re) => re.test(t))) return true;
  // "Patient Name: Jane Doe" or "CLIENT NAME: JANE DOE", but not a blank form's "Member Name: Member ID:".
  for (const m of t.matchAll(NAME_LABEL))
    if (looksLikeName(m[1]!) && looksLikeName(m[2]!) && !m[3]) return true;
  return false;
}

/** A member, subscriber, or Medicaid ID, or an SSN: synthetic SYN- ids, letter prefixes with long digit runs. */
const ID_PATTERNS: RegExp[] = [
  /\bSYN-[A-Z0-9-]+/i,
  /\b[A-Z]{1,4}-?\d{6,}\b/i,
  /\b\d{8,}\b/,
  /\b\d{3}-\d{2}-\d{4}\b/,
  /\b(?:member|subscriber|medicaid|patient|client|beneficiary|policy)\s*(?:id|number|no\.?|#)\s*(?:is|was)?\s*[:#]?\s*[A-Z]{0,4}-?\d{4,}/i,
];
const BIRTH_WORDS = /\b(?:dob|d\.o\.b\.?|date of birth|birth ?date|birthday|born (?:on|in))\b/i;
/** "my client Jane Doe", "for patient John Smith": a person word followed by a capitalized first and last name. */
const PERSON_THEN_NAME =
  /\b(?:client|patient|child|member|learner|kid|son|daughter|subscriber|beneficiary|student)(?:'s)?\s+(?:named\s+|is\s+)?([A-Z][a-z'-]+)\s+([A-Z][a-z'-]+)/g;
const NOT_NAMES = new Set(
  "name id plan plans treatment medicaid medicare tricare insurance services service record records letter policy portal handbook manual benefits benefit coverage health care advantage choice select".split(
    " ",
  ),
);

/**
 * A rule problem report is about the payor's rule, never about a client. Notes that look like they
 * carry a client's name, date of birth, or member ID are rejected (not stored). Errs toward rejecting.
 */
export function looksLikePhiInNote(note: string): boolean {
  const t = normalizeText(note);
  if (!t) return false;
  if (looksLikeClientRecord(t)) return true;
  if (BIRTH_WORDS.test(t)) return true;
  if (ID_PATTERNS.some((re) => re.test(t))) return true;
  for (const m of t.matchAll(PERSON_THEN_NAME))
    if (!NOT_NAMES.has(m[1]!.toLowerCase()) && !NOT_NAMES.has(m[2]!.toLowerCase())) return true;
  return false;
}
