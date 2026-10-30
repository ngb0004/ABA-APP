/**
 * Assessments a plan uses: the default selection, sourced values (tokens) for each selected
 * confirmed assessment, what the drafting model may see about them, and which sections need a
 * redraft when the selection changes. Pure and unit tested.
 *
 * Rule 2: every score reaches plan text only as a {{token}} naming a stored value. Labels and
 * facts carry no digits of their own (assessment names such as "Vineland-3" are tokens too), so
 * the model has nothing numeric to copy. Rule 9: only names of assessments, forms, and scales.
 */
import { addMonths, toDay, type Day } from "../dates";
import type { SourcedValue } from "../firewall";
import { SECTION_BY_KEY } from "../plan/sections";
import { catalogType, KIND_LABELS, type Catalog, type ScaleKind } from "./catalog";
import { assessmentItem, ordinal, skillsTotal, type AssessmentItem, type StoredAssessment } from "./view";

/** Confirmed assessments this recent are selected by default (BCBA question: Assessments). */
export const ASSESSMENT_LOOKBACK_MONTHS = 12;
export const ASSESSMENT_PREFIX = "assessment.";

/**
 * Where the default selection starts: twelve months before the plan was created, or the start
 * of the authorization the plan is written for when that is earlier (its whole period counts).
 */
export function assessmentWindowStart(planCreatedOn: Day, authStart: Day | null): Day {
  const lookback = addMonths(planCreatedOn, -ASSESSMENT_LOOKBACK_MONTHS);
  return authStart && authStart < lookback ? authStart : lookback;
}

/** Every confirmed assessment administered on or after the window start, oldest first. */
export function defaultAssessmentSelection(
  assessments: { id: string; status: string; administeredOn: Date | Day }[],
  windowStart: Day,
): string[] {
  return assessments
    .map((a) => ({ ...a, day: toDay(a.administeredOn) }))
    .filter((a) => a.status === "confirmed" && a.day >= windowStart)
    .sort((a, b) => a.day.localeCompare(b.day) || a.id.localeCompare(b.id))
    .map((a) => a.id);
}

export function sameSelection(a: string[], b: string[]): boolean {
  const x = new Set(a);
  const y = new Set(b);
  return x.size === y.size && [...x].every((k) => y.has(k));
}

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 40);

/**
 * The token name of an assessment's series: its type, plus its module (AFLS), its form where
 * repeats are compared per form (PDDBI parent vs teacher), or the BCBA's name for "other".
 */
export function seriesKey(
  catalog: Catalog,
  a: { typeKey: string; module: string | null; form: string | null; customName: string | null },
): string {
  const t = catalogType(catalog, a.typeKey);
  const parts = [a.typeKey];
  if (a.module) parts.push(a.module);
  if (t?.groupByForm && a.form) parts.push(a.form);
  if (a.typeKey === "other") parts.push(slug(a.customName ?? "") || "unnamed");
  return parts.join("_");
}

type Dated = StoredAssessment & { reviewedAt: Date | null };

/**
 * Each confirmed assessment's number within its series, oldest first (1, 2, ...). Numbering
 * counts every confirmed administration, selected or not, so a token keeps its meaning when the
 * selection changes. Confirmed rows are locked and never deleted.
 */
export function seriesNumbers(catalog: Catalog, all: Dated[]): Map<string, { series: string; n: number }> {
  const confirmed = all
    .filter((a) => a.status === "confirmed")
    .sort(
      (a, b) =>
        toDay(a.administeredOn).localeCompare(toDay(b.administeredOn)) ||
        (a.reviewedAt?.getTime() ?? 0) - (b.reviewedAt?.getTime() ?? 0) ||
        a.id.localeCompare(b.id),
    );
  const count = new Map<string, number>();
  const out = new Map<string, { series: string; n: number }>();
  for (const a of confirmed) {
    const series = seriesKey(catalog, a);
    const n = (count.get(series) ?? 0) + 1;
    count.set(series, n);
    out.set(a.id, { series, n });
  }
  return out;
}

const fmt = (n: number) => String(Math.round(n * 100) / 100);
const usDate = (d: Day) => `${d.slice(5, 7)}/${d.slice(8, 10)}/${d.slice(0, 4)}`;
const hasDigit = (s: string) => /\p{Nd}/u.test(s);
/** Mirrors plan/context UNIT_NOTE (kept here to avoid an import cycle). */
const UNIT_NOTE = " (renders with its unit; do not write the unit after the token)";

/** A score's display, and whether it already carries its unit. */
function display(kind: ScaleKind, value: number): { text: string; unit: boolean } {
  switch (kind) {
    case "percentile":
      return { text: `${ordinal(value)} percentile`, unit: true };
    case "percent":
      return { text: `${fmt(value)}%`, unit: true };
    case "age_equivalent_months":
      return { text: `${fmt(value)} ${fmt(value) === "1" ? "month" : "months"}`, unit: true };
    default:
      return { text: fmt(value), unit: false };
  }
}

/** One selected, confirmed assessment, with its token base ("assessment.vineland_3.2"). */
export type UsedAssessment = { item: AssessmentItem; base: string; series: string; n: number };

/** The selected assessments that can be used: confirmed ones only, oldest first. Drafts are left out. */
export function usedAssessments(
  catalog: Catalog,
  clientId: string,
  all: Dated[],
  selected: string[],
): UsedAssessment[] {
  const numbers = seriesNumbers(catalog, all);
  return all
    .filter((a) => selected.includes(a.id) && a.status === "confirmed" && numbers.has(a.id))
    .map((a) => {
      const { series, n } = numbers.get(a.id)!;
      return {
        item: assessmentItem(catalog, clientId, a),
        base: `${ASSESSMENT_PREFIX}${series}.${n}`,
        series,
        n,
      };
    })
    .sort(
      (a, b) =>
        (a.item.administeredOn ?? "").localeCompare(b.item.administeredOn ?? "") ||
        a.base.localeCompare(b.base),
    );
}

const tok = (k: string) => `{{${k}}}`;

/**
 * Sourced values for each selected confirmed assessment: name, date, administered by, form,
 * module, respondent, and every score (value, possible points where the scale has them, and the
 * computed total of a skills assessment), with qualitative facts free of digits.
 */
export function assessmentValues(
  catalog: Catalog,
  clientId: string,
  all: Dated[],
  selected: string[],
): SourcedValue[] {
  const out: SourcedValue[] = [];
  const used = usedAssessments(catalog, clientId, all, selected);
  for (const u of used) {
    const { item: a, base } = u;
    const href = `/clients/${clientId}/assessments#assessment-${a.id}`;
    const day = a.administeredOn!;
    const src = (field: string, extra = "") => ({
      kind: "assessment",
      id: a.id,
      field,
      description: `${a.typeName}${a.moduleName ? ` ${a.moduleName}` : ""}, administered ${usDate(day)} (confirmed assessment${extra})`,
      href,
    });
    const name = tok(`${base}.name`);
    const t = catalogType(catalog, a.typeKey);
    const nameDisplay = [a.typeName, a.moduleName].filter(Boolean).join(" ");
    const kindWord =
      t?.group === "skills"
        ? "a skills assessment"
        : t?.group === "standardized"
          ? "a standardized assessment"
          : "an assessment";
    out.push({
      key: `${base}.name`,
      label: `Name of ${kindWord} selected for this plan, administered on ${tok(`${base}.date`)}; write this token whenever you name the assessment`,
      value: nameDisplay,
      display: nameDisplay,
      source: src("typeKey"),
    });
    out.push({
      key: `${base}.date`,
      label: `Date ${name} was administered`,
      value: day,
      display: usDate(day),
      source: src("administeredOn"),
    });
    if (a.administeredBy)
      out.push({
        key: `${base}.administered_by`,
        label: `Initials or staff code of whoever administered ${name}`,
        value: a.administeredBy,
        display: a.administeredBy,
        source: src("administeredBy"),
      });
    for (const [field, text, what] of [
      ["form", a.formName, "Form"],
      ["module", a.moduleName, "Module"],
      ["respondent", a.respondentName, "Respondent (who answered)"],
    ] as const)
      if (text)
        out.push({
          key: `${base}.${field}`,
          label: `${what} of ${name}`,
          value: text,
          display: text,
          source: src(field),
        });

    // The previous selected administration of the same series, for higher / lower facts.
    const prev = used.filter((x) => x.series === u.series && x.n < u.n).at(-1);
    const facts = scoreFacts(a, prev?.item ?? null, prev ? tok(`${prev.base}.date`) : "");
    const names = new Map(a.scores.map((s) => [s.key, s.name]));
    for (const s of a.scores) {
      const key = `${base}.${s.key}`;
      // A scale named with digits (one the BCBA added) is named by its own token.
      let scaleName = s.name;
      if (hasDigit(s.name)) {
        out.push({
          key: `${key}.name`,
          label: `Name of a score the BCBA added to ${name}; write this token whenever you name it`,
          value: s.name,
          display: s.name,
          source: src(`scores.${s.key}.name`),
        });
        scaleName = `the score named ${tok(`${key}.name`)}`;
      }
      const parent = s.parent ? names.get(s.parent) : undefined;
      const d = display(s.kind, s.value);
      const possible = s.kind === "score_of_possible" && s.possible !== null;
      out.push({
        key,
        label:
          `${name} ${scaleName}, ${s.kind === "score_of_possible" ? "points scored" : KIND_LABELS[s.kind]}` +
          (parent && !hasDigit(parent) ? `, part of ${parent}` : "") +
          (possible ? `; the possible points are ${tok(`${key}.possible`)}` : "") +
          (d.unit ? UNIT_NOTE : ""),
        value: s.value,
        display: d.text,
        source: src(`scores.${s.key}.value`),
        facts: facts.get(s.key) ?? [],
      });
      if (possible)
        out.push({
          key: `${key}.possible`,
          label: `Possible points for ${name} ${scaleName}`,
          value: s.possible!,
          display: fmt(s.possible!),
          source: src(`scores.${s.key}.possible`),
        });
    }
    // A skills assessment's total is the sum of its scored areas, computed from the stored scores.
    const total = t?.summaryTotal ? skillsTotal(a.scores) : null;
    if (total && !a.scores.some((s) => s.key === "total")) {
      const areas = `the sum of its scored areas`;
      out.push({
        key: `${base}.total`,
        label: `${name} total points scored, ${areas}; the possible points are ${tok(`${base}.total.possible`)}`,
        value: total.value,
        display: fmt(total.value),
        source: src("scores", ", total computed from the stored area scores"),
      });
      out.push({
        key: `${base}.total.possible`,
        label: `${name} total possible points, ${areas}`,
        value: total.possible,
        display: fmt(total.possible),
        source: src("scores", ", total computed from the stored area scores"),
      });
    }
  }
  return out;
}

/**
 * Qualitative facts, names only: the lowest and highest skill area by share of possible points,
 * areas fully scored, the lowest and highest domain among top-level scores of one kind, and
 * whether a score is higher or lower than at the previous selected administration.
 */
export function scoreFacts(a: AssessmentItem, prev: AssessmentItem | null, prevDate: string) {
  const facts = new Map<string, string[]>();
  const add = (k: string, f: string) => facts.set(k, [...(facts.get(k) ?? []), f]);
  const areas = a.scores.filter((s) => s.kind === "score_of_possible" && !s.parent && s.possible);
  if (areas.length >= 2) {
    const share = (s: (typeof areas)[number]) => s.value / s.possible!;
    const low = Math.min(...areas.map(share));
    const high = Math.max(...areas.map(share));
    for (const s of areas) {
      if (s.value >= s.possible!) add(s.key, "every possible point in this area is scored");
      if (low === high) continue;
      if (share(s) === low) add(s.key, "lowest area of this assessment by share of possible points");
      if (share(s) === high) add(s.key, "highest area of this assessment by share of possible points");
    }
  }
  for (const kind of ["standard", "t_score"] as const) {
    const doms = a.scores.filter((s) => s.kind === kind && !s.parent);
    if (doms.length < 3) continue;
    const low = Math.min(...doms.map((s) => s.value));
    const high = Math.max(...doms.map((s) => s.value));
    if (low === high) continue;
    for (const s of doms) {
      if (s.value === low) add(s.key, `lowest ${KIND_LABELS[kind]} among this assessment's main scores`);
      if (s.value === high) add(s.key, `highest ${KIND_LABELS[kind]} among this assessment's main scores`);
    }
  }
  if (prev)
    for (const s of a.scores) {
      const p = prev.scores.find((x) => x.key === s.key);
      if (!p) continue;
      const word = s.value > p.value ? "higher than" : s.value < p.value ? "lower than" : "the same as";
      add(s.key, `${word} at the previous selected administration (${prevDate})`);
    }
  return facts;
}

/** A selected assessment as the drafting model sees it: names, tokens, and no digits outside tokens. */
export type AiAssessment = {
  name: string;
  administered: string;
  group: string;
  form?: string;
  module?: string;
  respondent?: string;
  scores: { scale: string; kind: string; token: string; possible?: string; partOf?: string }[];
  total?: { token: string; possible: string };
};

export function assessmentsForModel(used: UsedAssessment[], values: SourcedValue[]): AiAssessment[] {
  const has = new Set(values.map((v) => v.key));
  const safe = (s: string | null) => (s && !hasDigit(s) ? s : undefined);
  return used.map(({ item: a, base }) => {
    const names = new Map(a.scores.map((s) => [s.key, s.name]));
    return {
      name: tok(`${base}.name`),
      administered: tok(`${base}.date`),
      group: a.group,
      ...(safe(a.formName) ? { form: safe(a.formName) } : {}),
      ...(safe(a.moduleName) ? { module: safe(a.moduleName) } : {}),
      ...(safe(a.respondentName) ? { respondent: safe(a.respondentName) } : {}),
      scores: a.scores.map((s) => ({
        scale: hasDigit(s.name) ? tok(`${base}.${s.key}.name`) : s.name,
        kind: s.kind === "score_of_possible" ? "points scored" : KIND_LABELS[s.kind],
        token: tok(`${base}.${s.key}`),
        ...(has.has(`${base}.${s.key}.possible`) ? { possible: tok(`${base}.${s.key}.possible`) } : {}),
        ...(s.parent && safe(names.get(s.parent) ?? null) ? { partOf: names.get(s.parent)! } : {}),
      })),
      ...(has.has(`${base}.total`)
        ? { total: { token: tok(`${base}.total`), possible: tok(`${base}.total.possible`) } }
        : {}),
    };
  });
}

/** Section keys (of these) whose drafts draw on the selected assessments. */
export function sectionsUsingAssessments(sectionKeys: string[]): string[] {
  return sectionKeys.filter((k) =>
    SECTION_BY_KEY.get(k)?.valuePrefixes.some((p) => p.startsWith(ASSESSMENT_PREFIX)),
  );
}

export type RedraftSection = {
  key: string;
  state: string;
  content: string;
  aiDraft: string | null;
};

/**
 * Sections to flag for a redraft after the plan's assessments change: those that use
 * assessments and already have text. An approved section is reopened (draft when its text is
 * the untouched AI draft, otherwise edited), never approved again automatically. Sections
 * marked not applicable, and empty ones, are left alone.
 */
export function redraftMarks(
  sections: RedraftSection[],
): { key: string; state: string; reopened: boolean }[] {
  const uses = new Set(sectionsUsingAssessments(sections.map((s) => s.key)));
  return sections
    .filter((s) => uses.has(s.key) && s.state !== "not_applicable" && s.content.trim())
    .map((s) => {
      if (s.state !== "approved") return { key: s.key, state: s.state, reopened: false };
      const untouched = s.aiDraft !== null && s.content === s.aiDraft;
      return { key: s.key, state: untouched ? "draft" : "edited", reopened: true };
    });
}

export const REDRAFT_REASON = "The assessments used in this plan changed after this section was written.";
