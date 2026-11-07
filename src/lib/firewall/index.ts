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
  /**
   * The stable name rendered links carry (data-key and the default anchor) when the token key can
   * move: goal tokens follow the goal's position, which changes when an earlier goal is removed.
   */
  anchor?: string;
  /** Hover text for rendered links when "label. Source: description" would depend on other records. */
  title?: string;
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
const CARDINALS = [
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
  "billion",
  "dozen",
];
/** Every ordinal through "hundredth" is built from these plus the -ieth decades. */
const ORDINALS = [
  "first",
  "second",
  "third",
  "fourth",
  "fifth",
  "sixth",
  "seventh",
  "eighth",
  "ninth",
  "tenth",
  "eleventh",
  "twelfth",
  "thirteenth",
  "fourteenth",
  "fifteenth",
  "sixteenth",
  "seventeenth",
  "eighteenth",
  "nineteenth",
  "twentieth",
  "thirtieth",
  "fortieth",
  "fiftieth",
  "sixtieth",
  "seventieth",
  "eightieth",
  "ninetieth",
  "hundredth",
  "thousandth",
  "millionth",
];
const OTHER_QUANTITIES = [
  "percent",
  "percentage point",
  "half",
  "halves",
  "quarter",
  "twice",
  "thrice",
  "double",
  "triple",
  "quadruple",
  "twenties",
  "thirties",
  "forties",
  "fifties",
  "sixties",
  "seventies",
  "eighties",
  "nineties",
];
const NUMBER_WORDS = [...CARDINALS, ...ORDINALS, ...OTHER_QUANTITIES];
/** Each word and its plural ("dozens", "hundreds", "tenths"); compounds ("twenty-three") match by part. */
const NUMBER_WORD_RE = new RegExp(`\\b(?:${NUMBER_WORDS.join("|")})s?\\b`, "i");
/**
 * Month and weekday names place an event in time, which is a date the AI would be inventing.
 * Capitalized only, so the modal "may" passes; "May" counts after a word that introduces a date.
 */
const CALENDAR_RE = new RegExp(
  "\\b(?:January|February|March|April|June|July|August|September|October|November|December|" +
    "Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sept?|Oct|Nov|Dec|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)s?\\b|" +
    "\\b(?:in|since|by|until|of|on|through|before|after|during|early|late|mid|last|next|this)[\\s-]+May\\b",
);
/** A Roman numeral up to XXXIX ("II", "iv", "XII"). */
const ROMAN = "(?:x{1,3}(?:ix|iv|v?i{0,3})|ix|iv|v?i{1,3}|v)";
/**
 * A goal (or goals) referred to by number. Goals are not numbered in the plan, and "one" is not a
 * number word above, so "Goal One", "goal #", "goal No.", "goal number", and Roman numerals
 * ("Goal II", "goals IV and V", "goal No II") are caught here (digits already fail). "No" without
 * a period counts only before a numeral, so "the goal no longer applies" passes.
 */
const GOAL_BY_NUMBER_RE = new RegExp(
  `\\bgoals?\\s*(?:#|no\\.|number\\b|(?:no\\s+)?(?:one|${ROMAN})\\b)`,
  "i",
);
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
  // Every numeric character: digits, and also ½, ², ①, Ⅻ (Unicode No and Nl).
  const digits = outside.match(/\p{N}+/gu);
  if (digits) errors.push({ kind: "digit", detail: digits.slice(0, 5).join(", ") });
  const word =
    outside.match(NUMBER_WORD_RE) ?? outside.match(GOAL_BY_NUMBER_RE) ?? outside.match(CALENDAR_RE);
  if (word) errors.push({ kind: "number_word", detail: word[0] });
  return { ok: errors.length === 0, errors, normalized, keys };
}

/** BCBA-written text may contain numbers, but they are reported as unsourced so the audit can surface them. */
export function validateBcbaText(text: string, ctx: SourcedContext) {
  const normalized = normalize(text);
  const { errors, keys, outside } = scan(normalized, ctx);
  const unsourcedNumbers = outside.match(/\p{N}+(?:[.,]\p{N}+)?/gu) ?? [];
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
      const title = esc(v.title ?? `${v.label}. Source: ${v.source.description}`);
      const name = v.anchor ?? v.key;
      const href = esc(v.source.href ?? `#source-${name}`);
      parts.push(
        `<a class="sourced" data-key="${esc(name)}" href="${href}" title="${title}">${esc(v.display)}</a>`,
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
