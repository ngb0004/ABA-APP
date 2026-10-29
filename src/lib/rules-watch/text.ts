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
  const q = normalizeText(quote);
  // A whole number: not part of a longer number or the integer part of a decimal ("2" is not in "2.5").
  return [...new Set(nums)].filter(
    (n) => !new RegExp(`(^|[^\\d.])${n.replace(".", "\\.")}(?![\\d]|\\.\\d)`).test(q),
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
