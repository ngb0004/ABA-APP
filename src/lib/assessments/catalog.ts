/**
 * The assessment catalog (seed/assessments.yaml): which assessment types exist, their forms,
 * modules, and the scales each one reports. Data, not code: loaded and validated at startup.
 *
 * Rule 9: names only (assessments, domains, skill areas, subscales). No item wording.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { z } from "zod";

export const SCALE_KINDS = [
  "score_of_possible",
  "standard",
  "t_score",
  "percentile",
  "raw",
  "percent",
  "age_equivalent_months",
] as const;
export type ScaleKind = (typeof SCALE_KINDS)[number];

/** Sanity bounds per kind, used when a scale has no well-established range of its own. */
export const KIND_BOUNDS: Record<ScaleKind, { min: number; max: number }> = {
  score_of_possible: { min: 0, max: 10_000 },
  standard: { min: 0, max: 200 },
  t_score: { min: 0, max: 150 },
  percentile: { min: 0, max: 100 },
  raw: { min: 0, max: 10_000 },
  percent: { min: 0, max: 100 },
  age_equivalent_months: { min: 0, max: 600 },
};

export const KIND_LABELS: Record<ScaleKind, string> = {
  score_of_possible: "score of possible",
  standard: "standard score",
  t_score: "T-score",
  percentile: "percentile",
  raw: "raw score",
  percent: "percent",
  age_equivalent_months: "age equivalent (months)",
};

export const ASSESSMENT_GROUPS = ["skills", "standardized", "other"] as const;
export type AssessmentGroup = (typeof ASSESSMENT_GROUPS)[number];
export const GROUP_LABELS: Record<AssessmentGroup, string> = {
  skills: "Skills",
  standardized: "Standardized",
  other: "Other",
};

const Key = z.string().regex(/^[a-z][a-z0-9_]{0,47}$/, "Use lowercase letters, digits, and _");
const Name = z.string().trim().min(1).max(120);
/** Other ways a name is written in score reports and spreadsheets (used by file imports only). */
const Aliases = z.array(z.string().trim().min(1).max(80)).default([]);
const Choice = z.object({ key: Key, name: Name, aliases: Aliases }).strict();

const ScaleSchema = z
  .object({
    key: Key,
    name: Name,
    kind: z.enum(SCALE_KINDS),
    min: z.number().finite().optional(),
    max: z.number().finite().optional(),
    parent: Key.optional(),
    aliases: Aliases,
  })
  .strict();

const TypeSchema = z
  .object({
    key: Key,
    name: Name,
    aliases: Aliases,
    group: z.enum(ASSESSMENT_GROUPS),
    entry: z.enum(["manual", "vbmapp_import"]).default("manual"),
    forms: z.array(Choice).default([]),
    respondents: z.array(Choice).default([]),
    modules: z
      .array(z.object({ key: Key, name: Name, scales: z.array(ScaleSchema).default([]) }).strict())
      .default([]),
    scales: z.array(ScaleSchema).default([]),
    summary: z.array(Key).default([]),
    summary_total: z.boolean().default(false),
    custom_scales: z.boolean().default(false),
    group_by_form: z.boolean().default(false),
  })
  .strict();

const CatalogSchema = z
  .object({ version: z.number().int().positive(), assessments: z.array(TypeSchema).min(1) })
  .strict();

export type CatalogScale = z.infer<typeof ScaleSchema>;
export type CatalogModule = { key: string; name: string; scales: CatalogScale[] };
export type CatalogChoice = { key: string; name: string; aliases: string[] };
export type CatalogType = {
  key: string;
  name: string;
  aliases: string[];
  group: AssessmentGroup;
  entry: "manual" | "vbmapp_import";
  forms: CatalogChoice[];
  respondents: CatalogChoice[];
  modules: CatalogModule[];
  scales: CatalogScale[];
  summary: string[];
  summaryTotal: boolean;
  customScales: boolean;
  groupByForm: boolean;
};
export type Catalog = { version: number; types: CatalogType[] };

/**
 * A label reduced for comparison: lower case, "&" read as "and", possessives and punctuation
 * dropped, spacing collapsed. "Daily-Living Skills" and "daily living skills" compare equal.
 */
export function normalizeLabel(s: string): string {
  return s
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/['’]s\b/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

const dupes = (keys: string[]) => keys.filter((k, i) => keys.indexOf(k) !== i);

/** Cross-reference checks the schema cannot express. Returns plain-sentence problems. */
function problems(types: CatalogType[]): string[] {
  const out: string[] = [];
  for (const k of dupes(types.map((t) => t.key))) out.push(`Assessment type "${k}" is listed twice`);
  for (const t of types) {
    for (const k of dupes(t.modules.map((m) => m.key))) out.push(`${t.key}: module "${k}" is listed twice`);
    for (const k of dupes(t.forms.map((f) => f.key))) out.push(`${t.key}: form "${k}" is listed twice`);
    for (const k of dupes(t.respondents.map((f) => f.key)))
      out.push(`${t.key}: respondent "${k}" is listed twice`);
    if (t.entry === "vbmapp_import" && t.key !== "vbmapp")
      out.push(`${t.key}: only VB-MAPP uses the VB-MAPP workbook import`);
    const sets = t.modules.length
      ? t.modules.map((m) => ({ where: `${t.key}.${m.key}`, scales: [...t.scales, ...m.scales] }))
      : [{ where: t.key, scales: t.scales }];
    for (const { where, scales } of sets) {
      const keys = scales.map((s) => s.key);
      for (const k of dupes(keys)) out.push(`${where}: scale "${k}" is listed twice`);
      for (const s of scales) {
        if (s.parent && !keys.includes(s.parent))
          out.push(`${where}: scale "${s.key}" has an unknown parent "${s.parent}"`);
        if (s.parent === s.key) out.push(`${where}: scale "${s.key}" is its own parent`);
        const b = KIND_BOUNDS[s.kind];
        if (s.min !== undefined && s.max !== undefined && s.min > s.max)
          out.push(`${where}: scale "${s.key}" has min above max`);
        if ((s.min !== undefined && s.min < b.min) || (s.max !== undefined && s.max > b.max))
          out.push(`${where}: scale "${s.key}" range is outside what a ${KIND_LABELS[s.kind]} allows`);
        if (s.kind === "score_of_possible" && (s.min !== undefined || s.max !== undefined))
          out.push(`${where}: scale "${s.key}" is a score of possible; its range comes from "possible"`);
      }
      for (const k of t.summary)
        if (!keys.includes(k)) out.push(`${where}: summary scale "${k}" is not one of its scales`);
      // An import must never have to guess between two scales for one label.
      const seen = new Map<string, string>();
      for (const s of scales)
        for (const a of [s.name, ...s.aliases]) {
          const n = normalizeLabel(a);
          const other = seen.get(n);
          if (other && other !== s.key) out.push(`${where}: "${a}" names both "${other}" and "${s.key}"`);
          seen.set(n, s.key);
        }
    }
    if (t.summaryTotal && t.summary.length) out.push(`${t.key}: use either summary or summary_total`);
    if (t.summaryTotal && !t.customScales) {
      const all = [...t.scales, ...t.modules.flatMap((m) => m.scales)];
      if (!all.some((s) => s.kind === "score_of_possible"))
        out.push(`${t.key}: summary_total needs score-of-possible areas`);
    }
    if (!t.customScales && !t.scales.length && !t.modules.some((m) => m.scales.length))
      out.push(`${t.key}: has no scales and does not allow custom ones`);
  }
  return out;
}

export class CatalogError extends Error {
  name = "CatalogError";
}

/** Validates a parsed catalog document. Throws CatalogError listing every problem. */
export function parseAssessmentCatalog(doc: unknown): Catalog {
  const r = CatalogSchema.safeParse(doc);
  if (!r.success)
    throw new CatalogError(
      `Assessment catalog is invalid: ${r.error.issues
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; ")}`,
    );
  const types: CatalogType[] = r.data.assessments.map((t) => ({
    key: t.key,
    name: t.name,
    aliases: t.aliases,
    group: t.group,
    entry: t.entry,
    forms: t.forms,
    respondents: t.respondents,
    modules: t.modules,
    scales: t.scales,
    summary: t.summary,
    summaryTotal: t.summary_total,
    customScales: t.custom_scales,
    groupByForm: t.group_by_form,
  }));
  const p = problems(types);
  if (p.length) throw new CatalogError(`Assessment catalog is invalid: ${p.join("; ")}`);
  return { version: r.data.version, types };
}

export function loadAssessmentCatalog(file = path.join(process.cwd(), "seed/assessments.yaml")): Catalog {
  return parseAssessmentCatalog(YAML.parse(readFileSync(file, "utf8"), { merge: true }));
}

let cached: Catalog | null = null;
/** The catalog, loaded once per process. */
export function assessmentCatalog(): Catalog {
  cached ??= loadAssessmentCatalog();
  return cached;
}

export function catalogType(catalog: Catalog, key: string): CatalogType | undefined {
  return catalog.types.find((t) => t.key === key);
}

/** The scales an administration of this type (and module) can report. */
export function scalesFor(type: CatalogType, module?: string | null): CatalogScale[] {
  const m = module ? type.modules.find((x) => x.key === module) : undefined;
  return [...type.scales, ...(m?.scales ?? [])];
}

/** The valid range of a scale's value: its own range where established, else its kind's bounds. */
export function scaleBounds(s: { kind: ScaleKind; min?: number; max?: number }) {
  const b = KIND_BOUNDS[s.kind];
  return { min: s.min ?? b.min, max: s.max ?? b.max };
}

export const CUSTOM_PREFIX = "custom_";
/** A stable key for a scale the BCBA named: "custom_" plus a slug of the name. */
export function customScaleKey(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 40);
  return `${CUSTOM_PREFIX}${slug || "scale"}`;
}
