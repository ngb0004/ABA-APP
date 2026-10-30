/**
 * Validation for an assessment entered by a BCBA (or, later, confirmed from an import).
 * Pure and unit tested: every score is checked against the catalog (known scale, valid range,
 * score <= possible), the date cannot be in the future, and free text stays free of PHI.
 */
import { z } from "zod";
import { addDays, dayToDate, toDay, type Day } from "../dates";
import { HttpError } from "../log";
import { looksLikePhiInNote } from "../rules-watch/text";
import {
  KIND_LABELS,
  SCALE_KINDS,
  catalogType,
  customScaleKey,
  scaleBounds,
  scalesFor,
  type Catalog,
  type ScaleKind,
} from "./catalog";

/** Up to one day ahead is accepted (time zones), like the VB-MAPP workbook parser. */
export const FUTURE_TOLERANCE_DAYS = 1;
export const EARLIEST_DAY = "2000-01-01";

const Day = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Use a date (YYYY-MM-DD)")
  .refine((s) => {
    const d = dayToDate(s);
    return !Number.isNaN(d.getTime()) && toDay(d) === s;
  }, "Not a real calendar date");

const OptKey = z
  .string()
  .trim()
  .max(48)
  .nullish()
  .transform((v) => (v ? v : null));
const OptText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .nullish()
    .transform((v) => (v ? v : null));
const Num = z.number().finite().nullish();

export const AssessmentInputSchema = z.object({
  typeKey: z.string().trim().min(1).max(48),
  module: OptKey,
  form: OptKey,
  respondent: OptKey,
  customName: OptText(120),
  administeredOn: Day,
  administeredBy: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9][A-Za-z0-9.-]{0,23}$/, "Use initials or a staff code (no spaces), not a name"),
  notes: OptText(1000),
  scores: z
    .array(
      z.object({
        scaleKey: z.string().trim().max(60).nullish(),
        value: Num,
        possible: Num,
      }),
    )
    .max(120)
    .default([]),
  customScales: z
    .array(
      z.object({
        name: z.string().trim().max(80).nullish(),
        kind: z.union([z.enum(SCALE_KINDS), z.literal("")]).nullish(),
        value: Num,
        possible: Num,
      }),
    )
    .max(60)
    .default([]),
});
export type AssessmentInput = z.input<typeof AssessmentInputSchema>;

export type NormalizedScore = {
  scaleKey: string;
  /** Only for scales the BCBA added (custom); catalog scales take their name from the catalog. */
  scaleName: string | null;
  scaleKind: ScaleKind | null;
  value: number;
  possible: number | null;
};
export type NormalizedAssessment = {
  typeKey: string;
  module: string | null;
  form: string | null;
  respondent: string | null;
  customName: string | null;
  administeredOn: Day;
  administeredBy: string;
  notes: string | null;
  scores: NormalizedScore[];
};

export class AssessmentValidationError extends HttpError {
  constructor(public issues: string[]) {
    super(422, "Please fix the following:", issues);
  }
}

const num = (n: number) => String(Math.round(n * 100) / 100);

/** Range and possible checks for one score. Returns the problems, worded for the BCBA. */
function scoreIssues(
  name: string,
  kind: ScaleKind,
  bounds: { min: number; max: number },
  value: number,
  possible: number | null,
): string[] {
  if (kind === "score_of_possible") {
    if (possible === null) return [`${name}: enter the possible points`];
    if (possible <= 0) return [`${name}: the possible points must be more than 0`];
    if (possible > bounds.max) return [`${name}: the possible points must be at most ${num(bounds.max)}`];
    if (value < 0) return [`${name}: the score cannot be below 0`];
    if (value > possible)
      return [`${name}: the score (${num(value)}) cannot be more than the possible (${num(possible)})`];
    return [];
  }
  if (possible !== null) return [`${name}: leave possible blank (it is a ${KIND_LABELS[kind]})`];
  if (value < bounds.min || value > bounds.max)
    return [`${name} must be between ${num(bounds.min)} and ${num(bounds.max)}`];
  return [];
}

/**
 * Validates and normalizes an assessment against the catalog. Throws ZodError for malformed
 * input and AssessmentValidationError (422, one sentence per problem) for everything else.
 */
export function validateAssessment(catalog: Catalog, input: unknown, asOf: Day): NormalizedAssessment {
  const v = AssessmentInputSchema.parse(input);
  const issues: string[] = [];
  const fail = () => {
    throw new AssessmentValidationError(issues);
  };
  const type = catalogType(catalog, v.typeKey);
  if (!type) {
    issues.push(`Unknown assessment type "${v.typeKey}"`);
    fail();
  }
  const t = type!;
  if (t.entry === "vbmapp_import") {
    issues.push("VB-MAPP is imported from its scoring workbook, not entered here");
    fail();
  }

  let moduleOk = true;
  if (t.modules.length) {
    if (!v.module) {
      issues.push(`Choose the ${t.name} module`);
      moduleOk = false;
    } else if (!t.modules.some((m) => m.key === v.module)) {
      issues.push(`Unknown ${t.name} module "${v.module}"`);
      moduleOk = false;
    }
  } else if (v.module) issues.push(`${t.name} has no modules`);
  if (v.form && !t.forms.some((f) => f.key === v.form)) issues.push(`Unknown ${t.name} form "${v.form}"`);
  if (v.respondent && !t.respondents.some((r) => r.key === v.respondent))
    issues.push(`Unknown respondent "${v.respondent}"`);
  if (t.key === "other" && !v.customName) issues.push("Name the assessment");
  if (v.administeredOn > addDays(asOf, FUTURE_TOLERANCE_DAYS))
    issues.push(`The administration date cannot be in the future (today is ${asOf})`);
  if (v.administeredOn < EARLIEST_DAY) issues.push("The administration date must be in 2000 or later");
  if (v.notes && looksLikePhiInNote(v.notes))
    issues.push("Leave names, dates of birth, and member IDs out of the notes");

  const scores: NormalizedScore[] = [];
  const seen = new Set<string>();
  const moduleKey = t.modules.length && moduleOk ? v.module : null;
  const known = scalesFor(t, moduleKey);
  const where = moduleKey ? `${t.name} ${t.modules.find((m) => m.key === moduleKey)!.name}` : t.name;
  if (!t.modules.length || moduleOk) {
    for (const row of v.scores) {
      const key = row.scaleKey ?? "";
      const value = row.value ?? null;
      if (value === null) continue; // a blank row, or an area not scored
      if (!key) {
        issues.push("Choose the scale for each score");
        continue;
      }
      const s = known.find((x) => x.key === key);
      if (!s) {
        issues.push(`Unknown score "${key}" for ${where}`);
        continue;
      }
      if (seen.has(key)) {
        issues.push(`${s.name} is entered twice`);
        continue;
      }
      seen.add(key);
      const possible = row.possible ?? null;
      issues.push(...scoreIssues(s.name, s.kind, scaleBounds(s), value, possible));
      scores.push({ scaleKey: key, scaleName: null, scaleKind: null, value, possible });
    }
    const custom = v.customScales.filter((r) => r.name || (r.value ?? null) !== null);
    if (custom.length && !t.customScales)
      issues.push(`${t.name} does not take added scales; use the listed ones`);
    else
      for (const row of custom) {
        const name = row.name ?? "";
        if (!name) {
          issues.push("Name each added scale");
          continue;
        }
        const value = row.value ?? null;
        if (value === null) {
          issues.push(`${name}: enter a score or remove the row`);
          continue;
        }
        if (!row.kind) {
          issues.push(`${name}: choose the kind of score`);
          continue;
        }
        const key = customScaleKey(name);
        if (seen.has(key) || known.some((s) => s.name.toLowerCase() === name.toLowerCase())) {
          issues.push(`${name} is entered twice`);
          continue;
        }
        seen.add(key);
        const possible = row.possible ?? null;
        issues.push(...scoreIssues(name, row.kind, scaleBounds({ kind: row.kind }), value, possible));
        scores.push({ scaleKey: key, scaleName: name, scaleKind: row.kind, value, possible });
      }
  }
  if (issues.length) fail();
  return {
    typeKey: t.key,
    module: moduleKey,
    form: v.form,
    respondent: v.respondent,
    customName: t.key === "other" ? v.customName : null,
    administeredOn: v.administeredOn,
    administeredBy: v.administeredBy,
    notes: v.notes,
    scores,
  };
}
