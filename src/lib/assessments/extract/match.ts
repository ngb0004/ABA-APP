/**
 * Deterministic score matching: lines of cells (from any file format) against the chosen
 * assessment type's scale names and aliases from the catalog. Never the LLM.
 *
 * For each line: the first text cell is the label. When it names a scale (exactly, after
 * normalization; also without a parenthetical, or by the parenthetical abbreviation), the
 * numbers after it on the same line are read using the nearest column header above
 * ("Standard score", "Percentile", "T-score", "Raw score", "Score", "Possible"). A row may fill
 * the scale and its companions (e.g. the composite's percentile, the total's raw score).
 * "x of y" and "x/y" give a score and its possible points.
 *
 * What is kept: catalog keys, numbers, locations, and the catalog name that matched. Never the
 * file's own text. Everything proposed is reviewed by the BCBA before it is stored.
 */
import type { Day } from "../../dates";
import { addDays } from "../../dates";
import {
  KIND_LABELS,
  normalizeLabel,
  scaleBounds,
  scalesFor,
  type Catalog,
  type CatalogChoice,
  type CatalogScale,
  type CatalogType,
  type ScaleKind,
} from "../catalog";
import { EARLIEST_DAY, FUTURE_TOLERANCE_DAYS } from "../validate";
import { isBoundedNumber, parseDay, parseNumber, parseOfPossible, type Cell, type Line } from "./lines";
import { detectPhi, type PhiFound } from "./phi";

export const IMPORT_FORMATS = ["xlsx", "xls", "csv", "pdf", "image", "txt", "docx"] as const;
export type ImportFormat = (typeof IMPORT_FORMATS)[number];

export type Confidence = "high" | "medium" | "low";
export type ScoreFlag =
  | "out_of_range"
  | "over_possible"
  | "possible_missing"
  | "no_column_header"
  | "several_numbers"
  | "ocr_unsure";

export type ProposedScore = {
  scaleKey: string;
  value: number;
  possible: number | null;
  /** Where the number was read, e.g. "Skill areas!B4" or "page 1, line 8". */
  location: string;
  /** The catalog name or alias that matched (never the file's own text). */
  matchedLabel: string;
  confidence: Confidence;
  flags: ScoreFlag[];
};

export type ImportFlag = {
  code:
    | "phi_present"
    | "no_scores_found"
    | "duplicate_scale"
    | "bounded_value"
    | "several_dates"
    | "date_in_future"
    | "type_mismatch";
  severity: "warn" | "info";
  /** Plain sentence for the BCBA. Built from catalog names and numbers only. */
  message: string;
  locations: string[];
};

export type Proposal = {
  version: 1;
  format: ImportFormat;
  typeKey: string;
  module: string | null;
  scores: ProposedScore[];
  administeredOn: { value: Day; location: string } | null;
  form: { key: string; location: string } | null;
  respondent: { key: string; location: string } | null;
  phi: PhiFound;
  flags: ImportFlag[];
  stats: { lines: number; scales: number; matched: number };
};

// ---------------------------------------------------------------- column headers

type ColKind = ScaleKind | "score" | "possible" | "ignore";

/** What a column header (or a label suffix) says about the numbers under it. */
export function headerKind(text: string): ColKind | null {
  const t = normalizeLabel(text);
  if (!t) return null;
  if (
    /\b(confidence|interval|ci|range|band|description|descriptor|classification|level|qualitative|category|stanine|age equivalent|ae|growth|gsv|date)\b/.test(
      t,
    )
  )
    return "ignore";
  if (/\bpercentile|\bpctl?\b|\bpr\b|\bile\b/.test(t)) return "percentile";
  if (/\bt ?score\b|^t$|\bt scores?\b/.test(t)) return "t_score";
  if (/\bv ?scale\b|\bstandard\b|\bss\b|\bscaled\b|\bcomposite score\b|\bdomain score\b/.test(t))
    return "standard";
  if (/\braw\b/.test(t)) return "raw";
  if (/\bpercent\b|^pct$/.test(t)) return "percent";
  if (/\bpossible\b|\bmax(imum)?\b|\bout of\b|\btotal items\b|\bitems\b/.test(t)) return "possible";
  if (/\b(score|points?|obtained|earned|result|value)\b/.test(t)) return "score";
  return null;
}

type Header = { cols: (ColKind | null)[]; labelCol: number };

/** A header line: no numbers, and at least one cell names a kind of score. */
function asHeader(line: Line): Header | null {
  if (line.cells.some((c) => cellNumber(c) !== null || parseOfPossible(c.text))) return null;
  const cols = line.cells.map((c) => headerKind(c.text));
  if (!cols.some((k) => k && k !== "ignore")) return null;
  return { cols, labelCol: Math.max(0, cols.indexOf(null)) };
}

// ---------------------------------------------------------------- labels

type Alias = { key: string; label: string };

const STRIP_SUFFIX = /\s+(domain|subdomain|subscale|scale|skill area|area|skills area|index score)$/;
const KIND_SUFFIX: [RegExp, ScaleKind][] = [
  [/\s+(standard score|ss|v scale|v scale score|scaled score)$/, "standard"],
  [/\s+(t score|t)$/, "t_score"],
  [/\s+(percentile|percentile rank|pr)$/, "percentile"],
  [/\s+(raw score|raw)$/, "raw"],
];

/** Normalized label → scale. Names, names without "(...)", and catalog aliases. Ambiguous ones are dropped. */
export function aliasIndex(scales: CatalogScale[]): Map<string, Alias> {
  const out = new Map<string, Alias>();
  const ambiguous = new Set<string>();
  const add = (text: string, key: string, label: string) => {
    const n = normalizeLabel(text);
    if (!n) return;
    const had = out.get(n);
    if (had && had.key !== key) ambiguous.add(n);
    else if (!had) out.set(n, { key, label });
  };
  // Exact names and aliases first, so a derived form never shadows them.
  for (const s of scales) {
    add(s.name, s.key, s.name);
    for (const a of s.aliases) add(a, s.key, a);
  }
  for (const s of scales) {
    const bare = s.name.replace(/\s*\([^)]*\)\s*/g, " ").trim();
    if (bare !== s.name) add(bare, s.key, bare);
  }
  for (const n of ambiguous) out.delete(n);
  return out;
}

/** The scale a label cell names (and the kind its suffix implies), or null. */
export function matchLabel(
  text: string,
  index: Map<string, Alias>,
): { alias: Alias; impliedKind: ScaleKind | null } | null {
  const full = text.trim();
  const tries: string[] = [full];
  const bare = full.replace(/\s*\([^)]*\)\s*/g, " ").trim();
  if (bare !== full) tries.push(bare);
  for (const m of full.matchAll(/\(([^)]{1,40})\)/g)) tries.push(m[1]!);
  for (const t of tries) {
    let n = normalizeLabel(t).replace(/^the\s+/, "");
    const direct = index.get(n);
    if (direct) return { alias: direct, impliedKind: null };
    n = n.replace(STRIP_SUFFIX, "");
    if (index.get(n)) return { alias: index.get(n)!, impliedKind: null };
    for (const [re, kind] of KIND_SUFFIX)
      if (re.test(n)) {
        const base = n.replace(re, "").replace(STRIP_SUFFIX, "");
        const hit = index.get(base);
        if (hit) return { alias: hit, impliedKind: kind };
      }
  }
  return null;
}

// ---------------------------------------------------------------- values

function cellNumber(c: Cell): number | null {
  if (c.num !== undefined) return c.num;
  return parseNumber(c.text);
}

const LABEL_LIKE = /[A-Za-z]{2}/;

type Read = { value: number; possible: number | null; cell: Cell; kind: ColKind | "unknown" };

/** The values after the label, each with the kind of its column when a header says so. */
function valuesAfter(
  line: Line,
  labelAt: number,
  header: Header | null,
): { reads: Read[]; aligned: boolean; bounded: boolean } {
  const rest = line.cells.slice(labelAt + 1);
  let bounded = false;
  const reads: (Read | null)[] = rest.map((c) => {
    if (isBoundedNumber(c.text)) bounded = true;
    const of = c.num === undefined ? parseOfPossible(c.text) : null;
    if (of) return { ...of, cell: c, kind: "unknown" };
    const n = cellNumber(c);
    return n === null ? null : { value: n, possible: null, cell: c, kind: "unknown" };
  });
  if (!header) return { reads: reads.filter((r): r is Read => r !== null), aligned: false, bounded };
  const headerAfter = header.cols.slice(header.labelCol + 1);
  if (line.cells.length === header.cols.length && labelAt === header.labelCol) {
    // Same shape as the header: read each value under its own column.
    return {
      reads: reads.flatMap((r, i) => (r ? [{ ...r, kind: headerAfter[i] ?? "unknown" }] : [])),
      aligned: true,
      bounded,
    };
  }
  // Text layouts can lose empty cells: pair values with the header's value columns in order.
  const valueCols = headerAfter.filter((k) => k !== null);
  const vals = reads.filter((r): r is Read => r !== null);
  const restCells = rest.filter((c) => !LABEL_LIKE.test(c.text) || parseOfPossible(c.text));
  if (valueCols.length && vals.length === valueCols.length && restCells.length === vals.length)
    return { reads: vals.map((r, i) => ({ ...r, kind: valueCols[i]! })), aligned: true, bounded };
  return { reads: vals, aligned: false, bounded };
}

const round = (n: number) => Math.round(n * 1000) / 1000;

function rangeFlags(s: CatalogScale, value: number, possible: number | null): ScoreFlag[] {
  if (s.kind === "score_of_possible") {
    if (possible === null) return ["possible_missing"];
    const b = scaleBounds(s);
    if (value < 0 || possible <= 0 || possible > b.max) return ["out_of_range"];
    return value > possible ? ["over_possible"] : [];
  }
  const b = scaleBounds(s);
  return value < b.min || value > b.max ? ["out_of_range"] : [];
}

const lower = (c: Confidence): Confidence => (c === "high" ? "medium" : "low");

// ---------------------------------------------------------------- header fields

const DATE_LABEL =
  /^(?:date administered|administration date|date of administration|administered on|date administered on|test date|date tested|testing date|date of testing|assessment date|date of assessment|evaluation date|date of evaluation|rating date|date rated|date completed|completed on|date of report|interview date|date of interview)$/;
const FORM_LABEL = /^(?:form|form type|form used|version|rating form)$/;
const RESPONDENT_LABEL =
  /^(?:respondent|rater|informant|reporter|completed by|rated by|respondent type|rater type)$/;
const TYPE_LABEL = /^(?:assessment|instrument|measure|test|assessment tool|tool)$/;

function matchChoice(text: string, choices: CatalogChoice[]): CatalogChoice | null {
  const n = normalizeLabel(text);
  if (!n) return null;
  const hit = (c: CatalogChoice) => [c.name, ...c.aliases].map(normalizeLabel);
  return (
    choices.find((c) => hit(c).includes(n)) ??
    choices.find((c) => hit(c).some((a) => a === `${n} form` || n === `${a} form`)) ??
    // "Parent (mother)": the first word or a parenthetical decides, never a person's name.
    choices.find((c) => hit(c).some((a) => n.split(" ")[0] === a || new RegExp(`\\b${a}\\b`).test(n))) ??
    null
  );
}

/** The catalog type a named assessment is, by the longest name or alias it starts with. */
function typeNamed(text: string, catalog: Catalog): { key: string; name: string } | null {
  const n = normalizeLabel(text);
  let best: { key: string; name: string; len: number } | null = null;
  for (const t of catalog.types)
    for (const a of [t.name, ...t.aliases].map(normalizeLabel))
      if (a && (n === a || n.startsWith(`${a} `)) && (!best || a.length > best.len))
        best = { key: t.key, name: t.name, len: a.length };
  return best;
}

// ---------------------------------------------------------------- the matcher

/**
 * Proposes scores for one assessment type (and module) from a file's lines. Pure: the same
 * lines always give the same proposal.
 */
export function proposeScores(args: {
  catalog: Catalog;
  type: CatalogType;
  module: string | null;
  format: ImportFormat;
  lines: Line[];
  asOf: Day;
}): Proposal {
  const { catalog, type, module, format, lines, asOf } = args;
  const scales = scalesFor(type, module);
  const index = aliasIndex(scales);
  const byKey = new Map(scales.map((s) => [s.key, s]));
  const companions = (s: CatalogScale) => scales.filter((c) => c.parent === s.key && c.kind !== s.kind);
  const phi = detectPhi(lines);
  const flags: ImportFlag[] = [];
  const scores: ProposedScore[] = [];
  const dupes = new Map<string, string[]>();
  const dates: { value: Day; location: string }[] = [];
  const bounded: string[] = [];
  let form: Proposal["form"] = null;
  let respondent: Proposal["respondent"] = null;
  let header: Header | null = null;
  let sectionKind: ScaleKind | null = null;
  let lastGroup: string | undefined;

  const propose = (
    s: CatalogScale,
    value: number,
    possible: number | null,
    cell: Cell,
    matchedLabel: string,
    confidence: Confidence,
    extra: ScoreFlag[] = [],
  ) => {
    if (scores.some((x) => x.scaleKey === s.key)) {
      const first = scores.find((x) => x.scaleKey === s.key)!;
      if (first.value !== value || first.possible !== possible)
        dupes.set(s.key, [...(dupes.get(s.key) ?? [first.location]), cell.where]);
      return;
    }
    const f: ScoreFlag[] = [...extra, ...rangeFlags(s, value, possible)];
    let c = confidence;
    if (cell.conf !== undefined && cell.conf < 85) {
      f.push("ocr_unsure");
      c = cell.conf < 60 ? "low" : lower(c);
    }
    if (f.includes("out_of_range") || f.includes("over_possible")) c = "low";
    scores.push({
      scaleKey: s.key,
      value: round(value),
      possible: possible === null ? null : round(possible),
      location: cell.where,
      matchedLabel,
      confidence: c,
      flags: [...new Set(f)],
    });
  };

  lines.forEach((line, li) => {
    // A new sheet, page, or table starts without the previous table's header.
    if (line.group !== lastGroup) {
      header = null;
      sectionKind = null;
      lastGroup = line.group;
    }
    if (phi.lines.has(li)) return;
    const cells = line.cells;

    // Labelled fields: date, form, respondent, and the assessment's own name.
    for (let i = 0; i < cells.length; i++) {
      const label = normalizeLabel(cells[i]!.text);
      const next = cells[i + 1];
      if (DATE_LABEL.test(label) && next) {
        const d = next.date ?? parseDay(next.text);
        if (d) dates.push({ value: d, location: next.where });
      } else if (FORM_LABEL.test(label) && next && !form) {
        const f = matchChoice(next.text, type.forms);
        if (f) form = { key: f.key, location: next.where };
      } else if (RESPONDENT_LABEL.test(label) && next && !respondent) {
        const r = matchChoice(next.text, type.respondents);
        if (r) respondent = { key: r.key, location: next.where };
      } else if (TYPE_LABEL.test(label) && next) {
        const t = typeNamed(next.text, catalog);
        if (t && t.key !== type.key)
          flags.push({
            code: "type_mismatch",
            severity: "warn",
            message: `This file names ${t.name}, but ${type.name} was chosen. Check that the right assessment type was picked.`,
            locations: [next.where],
          });
      }
    }

    const h = asHeader(line);
    if (h) {
      if (cells.length === 1) {
        // A one-cell heading like "Domain T-scores" sets the kind for the rows below it.
        const k = h.cols[0];
        sectionKind = k && k !== "score" && k !== "possible" && k !== "ignore" ? k : null;
        header = null;
      } else header = h;
      return;
    }

    const labelAt = cells.findIndex((c) => LABEL_LIKE.test(c.text) && cellNumber(c) === null);
    if (labelAt < 0) return;
    const m = matchLabel(cells[labelAt]!.text, index);
    if (!m) return;
    let s = byKey.get(m.alias.key)!;
    if (m.impliedKind && m.impliedKind !== s.kind) {
      const c = companions(s).find((x) => x.kind === m.impliedKind);
      if (!c) return;
      s = c;
    }
    const { reads, aligned, bounded: isBounded } = valuesAfter(line, labelAt, header);
    if (isBounded) bounded.push(line.where);
    if (!reads.length) return;
    const base: Confidence = aligned || m.impliedKind || sectionKind ? "high" : "medium";
    const noHeader: ScoreFlag[] = aligned || m.impliedKind || sectionKind ? [] : ["no_column_header"];

    if (s.kind === "score_of_possible") {
      const of = reads.find((r) => r.possible !== null);
      if (of) return propose(s, of.value, of.possible, of.cell, m.alias.label, "high");
      const score = reads.find((r) => r.kind === "score" || r.kind === "raw");
      const poss = reads.find((r) => r.kind === "possible");
      if (score && poss) return propose(s, score.value, poss.value, score.cell, m.alias.label, "high");
      if (!aligned && reads.length === 2)
        return propose(s, reads[0]!.value, reads[1]!.value, reads[0]!.cell, m.alias.label, "medium", [
          "no_column_header",
        ]);
      const first = score ?? reads[0]!;
      return propose(s, first.value, null, first.cell, m.alias.label, "low");
    }

    const targets = [s, ...companions(s)];
    if (aligned) {
      for (const t of targets) {
        const r =
          reads.find((x) => x.kind === t.kind && x.possible === null) ??
          (t === s && !m.impliedKind
            ? reads.find((x) => x.kind === "score" && x.possible === null)
            : undefined);
        if (r)
          propose(
            t,
            r.value,
            null,
            r.cell,
            t === s ? m.alias.label : `${m.alias.label} (${KIND_LABELS[t.kind]})`,
            "high",
          );
      }
      return;
    }
    // No usable header: the first number is the scale's own score.
    const plain = reads.filter((r) => r.possible === null);
    if (!plain.length) return;
    const extra: ScoreFlag[] = [...noHeader, ...(plain.length > 1 ? (["several_numbers"] as const) : [])];
    propose(s, plain[0]!.value, null, plain[0]!.cell, m.alias.label, plain.length > 1 ? "low" : base, extra);
  });

  // The administration date: the first labelled one that is a plausible past date.
  const okDates = dates.filter(
    (d) => d.value >= EARLIEST_DAY && d.value <= addDays(asOf, FUTURE_TOLERANCE_DAYS),
  );
  const future = dates.filter((d) => d.value > addDays(asOf, FUTURE_TOLERANCE_DAYS));
  if (future.length)
    flags.push({
      code: "date_in_future",
      severity: "warn",
      message: "A labelled administration date is in the future and was not used. Enter the date by hand.",
      locations: future.map((d) => d.location),
    });
  if (new Set(okDates.map((d) => d.value)).size > 1)
    flags.push({
      code: "several_dates",
      severity: "warn",
      message: "The file has more than one administration date. The first one is filled in; check it.",
      locations: okDates.map((d) => d.location),
    });

  if (phi.where.length) {
    const kinds = [
      phi.phi.name && "a name",
      phi.phi.dob && "a date of birth",
      phi.phi.memberId && "an ID number",
    ].filter(Boolean) as string[];
    flags.unshift({
      code: "phi_present",
      severity: "warn",
      message: `The file contains ${kinds.join(" and ").replace(/ and (?=.* and )/, ", ")}. ${kinds.length > 1 ? "They were" : "It was"} not read or stored; those lines were skipped.`,
      locations: phi.where,
    });
  }
  for (const [key, where] of dupes)
    flags.push({
      code: "duplicate_scale",
      severity: "warn",
      message: `${byKey.get(key)!.name} appears more than once with different numbers. The first is filled in; check it.`,
      locations: where,
    });
  if (bounded.length)
    flags.push({
      code: "bounded_value",
      severity: "info",
      message:
        'Some scores are written as a bound (like "<1") and cannot be stored as a number. Enter them by hand if needed.',
      locations: bounded,
    });
  if (!scores.length)
    flags.push({
      code: "no_scores_found",
      severity: "warn",
      message: `No ${type.name} scale names with scores were found. Enter the scores by hand below.`,
      locations: [],
    });

  return {
    version: 1,
    format,
    typeKey: type.key,
    module,
    scores,
    administeredOn: okDates[0] ?? null,
    form,
    respondent,
    phi: phi.phi,
    flags,
    stats: { lines: lines.length, scales: scales.length, matched: scores.length },
  };
}
