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

/** Every number in the rule's parameters must appear in the quote that verifies it. */
export function numbersMissingFromQuote(params: unknown, quote: string): number[] {
  const nums: number[] = [];
  const walk = (v: unknown) => {
    if (typeof v === "number" && Number.isFinite(v)) nums.push(v);
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === "object") Object.values(v).forEach(walk);
  };
  walk(params);
  const q = normalizeText(quote);
  return [...new Set(nums)].filter(
    (n) => !new RegExp(`(^|[^\\d.])${String(n).replace(".", "\\.")}(?![\\d])`).test(q),
  );
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
