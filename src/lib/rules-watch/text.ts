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
  /\b(?:date of birth|dob|birth ?date)\s*[:#]?\s*\d{1,2}[/-]\d{1,2}[/-]\d{2,4}/i,
  /\b(?:member|subscriber|patient|beneficiary|client|medicaid)\s*(?:id|number|no\.?|#)\s*[:#]\s*[A-Z]{0,4}\d[A-Z0-9-]{5,}/i,
  /\b(?:patient|client|member|beneficiary|child'?s?|subscriber)\s*name\s*:\s*[A-Z][a-z]+\s+[A-Z][a-z]+/,
];
export function looksLikeClientRecord(text: string): boolean {
  const t = normalizeText(text);
  return CLIENT_RECORD_PATTERNS.some((re) => re.test(t));
}
