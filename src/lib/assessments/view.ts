/**
 * One list of a client's assessments, whatever their type: stored assessments and VB-MAPP
 * administrations (adapted from VbmappAdministration, which keeps its own import and grid).
 * Pure and unit tested: summary scores, skills totals, grouping of repeats, and progress.
 */
import { toDay, type Day } from "../dates";
import { LEVELS, POINTS_PER_LEVEL } from "../vbmapp/layout";
import { assessmentCatalog, catalogType, scalesFor, type Catalog, type ScaleKind } from "./catalog";

export type AssessmentSource = "manual" | "import" | "vbmapp_import";
export type AssessmentStatus = "draft" | "confirmed";

/** A stored assessment row with its scores (Prisma shape, minus ids that are not shown). */
export type StoredAssessment = {
  id: string;
  typeKey: string;
  module: string | null;
  form: string | null;
  respondent: string | null;
  customName: string | null;
  administeredOn: Date;
  administeredBy: string;
  source: string;
  status: string;
  reviewedAt: Date | null;
  notes: string | null;
  scores: {
    scaleKey: string;
    scaleName: string | null;
    scaleKind: string | null;
    value: number;
    possible: number | null;
  }[];
};

export type DisplayScore = {
  key: string;
  name: string;
  kind: ScaleKind;
  value: number;
  possible: number | null;
  parent: string | null;
  /** Computed here (a skills total), not a stored value. */
  computed?: boolean;
};

export type AssessmentItem = {
  id: string;
  source: AssessmentSource;
  typeKey: string;
  /** The catalog name, or the BCBA's name for an "other" assessment. */
  typeName: string;
  group: string;
  module: string | null;
  moduleName: string | null;
  form: string | null;
  formName: string | null;
  respondent: string | null;
  respondentName: string | null;
  customName: string | null;
  administeredOn: Day | null;
  administeredBy: string | null;
  status: AssessmentStatus;
  reviewedAt: Date | null;
  notes: string | null;
  scores: DisplayScore[];
  summary: DisplayScore[];
  /** VB-MAPP rows open the existing grid page. */
  href: string | null;
  /** VB-MAPP administration number. */
  adminNumber?: number;
};

const round = (n: number) => Math.round(n * 1000) / 1000;

/** Sum of the top-level score-of-possible areas that have a possible. Null when none. */
export function skillsTotal(
  scores: DisplayScore[],
): { value: number; possible: number; areas: number } | null {
  const areas = scores.filter((s) => s.kind === "score_of_possible" && !s.parent && s.possible !== null);
  if (!areas.length) return null;
  return {
    value: round(areas.reduce((n, s) => n + s.value, 0)),
    possible: round(areas.reduce((n, s) => n + s.possible!, 0)),
    areas: areas.length,
  };
}

export function assessmentItem(catalog: Catalog, _clientId: string, a: StoredAssessment): AssessmentItem {
  const t = catalogType(catalog, a.typeKey);
  const known = t ? scalesFor(t, a.module) : [];
  const scores: DisplayScore[] = a.scores.map((s) => {
    const c = known.find((k) => k.key === s.scaleKey);
    return {
      key: s.scaleKey,
      name: c?.name ?? s.scaleName ?? s.scaleKey,
      kind: (c?.kind ?? s.scaleKind ?? "raw") as ScaleKind,
      value: s.value,
      possible: s.possible,
      parent: c?.parent ?? null,
    };
  });
  // Catalog order first (so domains read in their usual order), then added scales as entered.
  const order = (k: string) => {
    const i = known.findIndex((s) => s.key === k);
    return i < 0 ? known.length : i;
  };
  scores.sort((x, y) => order(x.key) - order(y.key));
  let summary: DisplayScore[];
  if (t?.summaryTotal) {
    const total = skillsTotal(scores);
    summary = total
      ? [
          {
            key: "total",
            name: `Total (${total.areas} area${total.areas === 1 ? "" : "s"})`,
            kind: "score_of_possible",
            value: total.value,
            possible: total.possible,
            parent: null,
            computed: true,
          },
        ]
      : [];
  } else if (t?.summary.length) summary = scores.filter((s) => t.summary.includes(s.key));
  else summary = scores.filter((s) => !s.parent).slice(0, 4);
  const mod = t?.modules.find((m) => m.key === a.module);
  return {
    id: a.id,
    source: a.source as AssessmentSource,
    typeKey: a.typeKey,
    typeName: a.typeKey === "other" && a.customName ? a.customName : (t?.name ?? a.typeKey),
    group: t?.group ?? "other",
    module: a.module,
    moduleName: mod?.name ?? null,
    form: a.form,
    formName: t?.forms.find((f) => f.key === a.form)?.name ?? null,
    respondent: a.respondent,
    respondentName: t?.respondents.find((r) => r.key === a.respondent)?.name ?? null,
    customName: a.customName,
    administeredOn: toDay(a.administeredOn),
    administeredBy: a.administeredBy,
    status: a.status === "confirmed" ? "confirmed" : "draft",
    reviewedAt: a.reviewedAt,
    notes: a.notes,
    scores,
    summary,
    href: null,
  };
}

export type VbmappAdminLike = {
  id: string;
  adminNumber: number;
  testDate: Date | null;
  testerInitials: string | null;
  totals: unknown;
  verified: boolean;
  reviewedAt: Date | null;
};

/** A VB-MAPP administration as a list item. Totals are the ones recomputed from the grid. */
export function vbmappItem(catalog: Catalog, clientId: string, a: VbmappAdminLike): AssessmentItem {
  const t = catalogType(catalog, "vbmapp")!;
  const totals = (a.totals ?? {}) as { total?: number; levels?: Record<string, number> };
  const possible = Object.fromEntries(LEVELS.map((l) => [l.level, POINTS_PER_LEVEL(l)]));
  const totalPossible = LEVELS.reduce((n, l) => n + POINTS_PER_LEVEL(l), 0);
  const scale = (key: string) => t.scales.find((s) => s.key === key)!;
  const scores: DisplayScore[] = [
    {
      key: "total",
      name: scale("total").name,
      kind: scale("total").kind,
      value: totals.total ?? 0,
      possible: totalPossible,
      parent: null,
    },
    ...LEVELS.map((l) => ({
      key: `level_${l.level}`,
      name: scale(`level_${l.level}`).name,
      kind: scale(`level_${l.level}`).kind,
      value: totals.levels?.[String(l.level)] ?? 0,
      possible: possible[l.level]!,
      parent: "total",
    })),
  ];
  return {
    id: a.id,
    source: "vbmapp_import",
    typeKey: "vbmapp",
    typeName: t.name,
    group: t.group,
    module: null,
    moduleName: null,
    form: null,
    formName: null,
    respondent: null,
    respondentName: null,
    customName: null,
    administeredOn: a.testDate ? toDay(a.testDate) : null,
    administeredBy: a.testerInitials,
    status: a.verified ? "confirmed" : "draft",
    reviewedAt: a.reviewedAt,
    notes: null,
    scores,
    summary: scores.filter((s) => t.summary.includes(s.key)),
    href: `/clients/${clientId}/vbmapp#admin-${a.adminNumber}`,
    adminNumber: a.adminNumber,
  };
}

/** Newest first; undated items last; ties keep a stable order by id. */
export function newestFirst(items: AssessmentItem[]): AssessmentItem[] {
  return [...items].sort(
    (a, b) =>
      (b.administeredOn ?? "").localeCompare(a.administeredOn ?? "") ||
      (b.adminNumber ?? 0) - (a.adminNumber ?? 0) ||
      a.id.localeCompare(b.id),
  );
}

export type ProgressRow = {
  key: string;
  name: string;
  kind: ScaleKind;
  /** One cell per administration, oldest to newest; null where that scale was not scored. */
  cells: ({ value: number; possible: number | null } | null)[];
  /** Newest minus oldest, when both ends were scored. */
  change: number | null;
};
export type AssessmentGroupView = {
  key: string;
  label: string;
  typeKey: string;
  /** Newest first. */
  items: AssessmentItem[];
  /** Repeats side by side (two or more administrations), oldest to newest. */
  progress: { dates: (Day | null)[]; rows: ProgressRow[] } | null;
};

function groupKey(catalog: Catalog, i: AssessmentItem): { key: string; label: string } {
  const t = catalogType(catalog, i.typeKey);
  const parts = [i.typeKey, i.module ?? ""];
  const label = [i.typeName, i.moduleName];
  if (t?.groupByForm) {
    parts.push(i.form ?? "");
    label.push(i.formName);
  }
  if (i.typeKey === "other") parts.push((i.customName ?? "").toLowerCase());
  return { key: parts.join("|"), label: label.filter(Boolean).join(" · ") };
}

function progressOf(items: AssessmentItem[]): AssessmentGroupView["progress"] {
  if (items.length < 2) return null;
  const cols = [...items].reverse();
  const keys: { key: string; name: string; kind: ScaleKind }[] = [];
  for (const i of cols)
    for (const s of i.summary)
      if (!keys.some((k) => k.key === s.key)) keys.push({ key: s.key, name: s.name, kind: s.kind });
  const rows = keys.map((k) => {
    const cells = cols.map((i) => {
      const s = i.summary.find((x) => x.key === k.key);
      return s ? { value: s.value, possible: s.possible } : null;
    });
    const first = cells[0];
    const last = cells[cells.length - 1];
    // Skills totals carry the area count in their name; the row reads "Total".
    const name = k.key === "total" && cols.some((i) => i.summary.some((s) => s.computed)) ? "Total" : k.name;
    return {
      key: k.key,
      name,
      kind: k.kind,
      cells,
      change: first && last ? round(last.value - first.value) : null,
    };
  });
  return { dates: cols.map((i) => i.administeredOn), rows };
}

/** Repeats of the same assessment together; groups ordered by their newest administration. */
export function groupAssessments(
  items: AssessmentItem[],
  cat: Catalog = assessmentCatalog(),
): AssessmentGroupView[] {
  const groups = new Map<string, AssessmentGroupView>();
  for (const i of newestFirst(items)) {
    const { key, label } = groupKey(cat, i);
    const g = groups.get(key);
    if (g) g.items.push(i);
    else groups.set(key, { key, label, typeKey: i.typeKey, items: [i], progress: null });
  }
  const out = [...groups.values()];
  for (const g of out) g.progress = progressOf(g.items);
  return out;
}

const fmt = (n: number) => String(Math.round(n * 100) / 100);
function ordinal(n: number): string {
  if (!Number.isInteger(n)) return fmt(n);
  const t = n % 100;
  if (t >= 11 && t <= 13) return `${n}th`;
  return `${n}${["th", "st", "nd", "rd"][n % 10] ?? "th"}`;
}

/** A score as the BCBA reads it ("12 / 20", "T 62", "3rd percentile"). For display, never AI text. */
export function formatScore(kind: ScaleKind, value: number, possible: number | null): string {
  if (possible !== null && possible !== undefined) return `${fmt(value)} / ${fmt(possible)}`;
  switch (kind) {
    case "t_score":
      return `T ${fmt(value)}`;
    case "percentile":
      return `${ordinal(value)} percentile`;
    case "percent":
      return `${fmt(value)}%`;
    case "age_equivalent_months":
      return `${fmt(value)} mo`;
    default:
      return fmt(value);
  }
}
