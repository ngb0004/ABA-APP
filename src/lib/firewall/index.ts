/**
 * The numeric firewall (CLAUDE.md rule 2).
 *
 * AI text may reference figures only as {{key}} tokens that name a stored,
 * sourced value. Any digit (or spelled-out number) outside a token, any
 * malformed token, and any unknown key fails validation. The renderer is the
 * only place values are substituted, and every rendered number links to its source.
 */

export type ValueSource = {
  kind: string;
  id?: string;
  field?: string;
  /** Human-readable provenance, e.g. "VB-MAPP administration 2 (recomputed)". */
  description: string;
  href?: string;
};

export type SourcedValue = {
  key: string;
  /** Shown to the model instead of the value. */
  label: string;
  value: string | number;
  display: string;
  source: ValueSource;
  /** Non-numeric qualitative facts the model may use (e.g. "lowest domain"). */
  facts?: string[];
};

export class SourcedContext {
  private map = new Map<string, SourcedValue>();
  constructor(values: SourcedValue[] = []) {
    for (const v of values) this.add(v);
  }
  add(v: SourcedValue) {
    if (!KEY_RE.test(v.key)) throw new Error(`Invalid sourced key: ${v.key}`);
    this.map.set(v.key, v);
  }
  get(key: string) {
    return this.map.get(key);
  }
  has(key: string) {
    return this.map.has(key);
  }
  keys() {
    return [...this.map.keys()];
  }
  values() {
    return [...this.map.values()];
  }
  /** What the model sees: keys, labels and qualitative facts, never values. */
  forModel(prefixes?: string[]) {
    return this.values()
      .filter((v) => !prefixes || prefixes.some((p) => v.key === p || v.key.startsWith(p)))
      .map((v) => ({ key: v.key, label: v.label, ...(v.facts?.length ? { facts: v.facts } : {}) }));
  }
}

const KEY_RE = /^[a-zA-Z][a-zA-Z0-9_.:-]*$/;
const TOKEN_RE = /\{\{\s*([a-zA-Z][a-zA-Z0-9_.:-]*)\s*\}\}/g;

/** Spelled-out quantities. "one" is excluded: it is overwhelmingly a pronoun in clinical prose. */
const NUMBER_WORDS = [
  "zero",
  "two",
  "three",
  "four",
  "five",
  "six",
  "seven",
  "eight",
  "nine",
  "ten",
  "eleven",
  "twelve",
  "thirteen",
  "fourteen",
  "fifteen",
  "sixteen",
  "seventeen",
  "eighteen",
  "nineteen",
  "twenty",
  "thirty",
  "forty",
  "fifty",
  "sixty",
  "seventy",
  "eighty",
  "ninety",
  "hundred",
  "thousand",
  "million",
  "dozen",
  "percent",
  "percentage point",
  "half",
  "quarter",
  "twice",
  "thrice",
  "double",
  "triple",
  "first",
  "second",
  "third",
  "fourth",
  "fifth",
];
const NUMBER_WORD_RE = new RegExp(`\\b(${NUMBER_WORDS.join("|")})\\b`, "i");
// "first"/"second" also appear in ordinary prose ("first, ..."), but an ordinal can
// state a rank or date, so they are rejected; the prompt tells the model to avoid them.

export type FirewallError = {
  kind: "digit" | "number_word" | "unknown_key" | "malformed_token";
  detail: string;
};
export type FirewallResult = { ok: boolean; errors: FirewallError[]; normalized: string; keys: string[] };

function normalize(text: string): string {
  return text
    .replace(/\[Client\]/g, "{{client.name}}")
    .replace(/\[Caregiver\]/g, "{{caregiver.primary}}")
    .replace(TOKEN_RE, (_, k: string) => `{{${k}}}`)
    .trim();
}

function scan(text: string, ctx: SourcedContext) {
  const errors: FirewallError[] = [];
  const keys: string[] = [];
  for (const m of text.matchAll(TOKEN_RE)) {
    keys.push(m[1]!);
    if (!ctx.has(m[1]!)) errors.push({ kind: "unknown_key", detail: m[1]! });
  }
  const outside = text.replace(TOKEN_RE, " ");
  if (/\{\{|\}\}|\{|\}/.test(outside))
    errors.push({ kind: "malformed_token", detail: (outside.match(/.{0,20}[{}].{0,20}/)?.[0] ?? "").trim() });
  return { errors, keys, outside };
}

export function validateAiText(text: string, ctx: SourcedContext): FirewallResult {
  const normalized = normalize(text);
  const { errors, keys, outside } = scan(normalized, ctx);
  const digits = outside.match(/\p{Nd}+/gu);
  if (digits) errors.push({ kind: "digit", detail: digits.slice(0, 5).join(", ") });
  const word = outside.match(NUMBER_WORD_RE);
  if (word) errors.push({ kind: "number_word", detail: word[0] });
  return { ok: errors.length === 0, errors, normalized, keys };
}

/** BCBA-written text may contain numbers, but they are reported as unsourced so the audit can surface them. */
export function validateBcbaText(text: string, ctx: SourcedContext) {
  const normalized = normalize(text);
  const { errors, keys, outside } = scan(normalized, ctx);
  const unsourcedNumbers = outside.match(/\p{Nd}+(?:[.,]\p{Nd}+)?/gu) ?? [];
  return { ok: errors.length === 0, errors, normalized, keys, unsourcedNumbers };
}

const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/**
 * Substitute sourced values. HTML mode wraps each value in a link to its source,
 * with the provenance in a tooltip. An unknown key throws: it never renders.
 */
export function renderTokens(text: string, ctx: SourcedContext, mode: "html" | "text"): string {
  // Goal-library placeholders resolve to sourced values when the record has them.
  if (ctx.has("client.name")) text = text.replace(/\[Client\]/g, "{{client.name}}");
  if (ctx.has("caregiver.primary")) text = text.replace(/\[Caregiver\]/g, "{{caregiver.primary}}");
  const parts: string[] = [];
  let last = 0;
  for (const m of text.matchAll(TOKEN_RE)) {
    const v = ctx.get(m[1]!);
    if (!v) throw new Error(`Cannot render unknown key ${m[1]}`);
    const before = text.slice(last, m.index);
    parts.push(mode === "html" ? esc(before) : before);
    if (mode === "text") parts.push(v.display);
    else {
      const title = esc(`${v.label}. Source: ${v.source.description}`);
      const href = esc(v.source.href ?? `#source-${v.key}`);
      parts.push(
        `<a class="sourced" data-key="${esc(v.key)}" href="${href}" title="${title}">${esc(v.display)}</a>`,
      );
    }
    last = m.index! + m[0].length;
  }
  const tail = text.slice(last);
  parts.push(mode === "html" ? esc(tail) : tail);
  return parts.join("");
}

export function tokensIn(text: string): string[] {
  return [...text.matchAll(TOKEN_RE)].map((m) => m[1]!);
}
