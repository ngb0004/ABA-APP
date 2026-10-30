/**
 * Entry-form fields for an assessment type, built from the catalog (data, not code). Plain data,
 * so the server page can pass them to client components.
 */
import {
  GROUP_LABELS,
  KIND_LABELS,
  SCALE_KINDS,
  ASSESSMENT_GROUPS,
  catalogType,
  scaleBounds,
  scalesFor,
  type Catalog,
  type CatalogType,
} from "@/lib/assessments/catalog";
import type { AssessmentItem } from "@/lib/assessments/view";
import type { FieldSpec } from "./record-form";

const fmt = (n: number) => String(Math.round(n * 100) / 100);

/** "Adaptive Behavior Composite (standard score, 20 to 140)". */
function scaleOption(s: {
  key: string;
  name: string;
  kind: (typeof SCALE_KINDS)[number];
  min?: number;
  max?: number;
}) {
  if (s.kind === "score_of_possible") return { value: s.key, label: `${s.name} (score of possible)` };
  const b = scaleBounds(s);
  const range = s.min !== undefined || s.max !== undefined ? `, ${fmt(b.min)} to ${fmt(b.max)}` : "";
  return { value: s.key, label: `${s.name} (${KIND_LABELS[s.kind]}${range})` };
}

/** Whether a score row has a "Possible" field: only when a listed scale takes one. */
const takesPossible = (scales: { kind: string }[]) => scales.some((s) => s.kind === "score_of_possible");

export function assessmentFields(t: CatalogType, module: string | null): FieldSpec[] {
  const scales = scalesFor(t, module);
  const fields: FieldSpec[] = [];
  if (t.key === "other")
    fields.push({
      name: "customName",
      label: "Assessment name",
      help: "The assessment's name, never a person's",
    });
  fields.push(
    { name: "administeredOn", label: "Date administered", type: "date" },
    {
      name: "administeredBy",
      label: "Administered by",
      placeholder: "AS or BCBA-Q",
      help: "Initials or a staff code, never a name",
    },
  );
  if (t.forms.length)
    fields.push({
      name: "form",
      label: "Form",
      type: "select",
      optional: true,
      options: t.forms.map((f) => ({ value: f.key, label: f.name })),
    });
  if (t.respondents.length)
    fields.push({
      name: "respondent",
      label: "Respondent",
      type: "select",
      optional: true,
      options: t.respondents.map((r) => ({ value: r.key, label: r.name })),
    });
  // "Possible" only where a listed scale takes one (skill areas), never on standard scores.
  const ofPossible = scales.filter((s) => s.kind === "score_of_possible").length;
  if (scales.length)
    fields.push({
      name: "scores",
      label: "Scores",
      type: "list",
      addLabel: "Add score",
      fields: [
        { name: "scaleKey", label: "Scale", type: "select", options: scales.map(scaleOption) },
        { name: "value", label: "Score", type: "number" },
        ...(ofPossible
          ? [
              {
                name: "possible",
                label: "Possible",
                type: "number" as const,
                help: ofPossible < scales.length ? "Score-of-possible areas only" : undefined,
              },
            ]
          : []),
      ],
    });
  if (t.customScales)
    fields.push({
      name: "customScales",
      label: t.key === "other" ? "Scores" : "Other areas or scales",
      type: "list",
      addLabel: t.key === "other" ? "Add score" : "Add area",
      fields: [
        { name: "name", label: "Name" },
        {
          name: "kind",
          label: "Kind",
          type: "select",
          options: SCALE_KINDS.map((k) => ({ value: k, label: KIND_LABELS[k] })),
        },
        { name: "value", label: "Score", type: "number" },
        { name: "possible", label: "Possible", type: "number" },
      ],
    });
  fields.push({
    name: "notes",
    label: "Notes",
    optional: true,
    help: "Optional. No names, birth dates, or IDs",
  });
  return fields;
}

/**
 * Rows a new form starts with: every listed skill area (skills assessments are usually scored in
 * full), or the summary scales of a standardized one. Unscored rows are left blank and dropped.
 */
export function initialRows(t: CatalogType, module: string | null) {
  const scales = scalesFor(t, module);
  const pick = t.group === "skills" ? scales : scales.filter((s) => t.summary.includes(s.key));
  return pick.map((s) => ({
    scaleKey: s.key,
    value: "",
    ...(takesPossible(scales) ? { possible: "" } : {}),
  }));
}

export type AddOption = {
  value: string;
  label: string;
  /** VB-MAPP: open the workbook import page instead of a form. */
  href?: string;
  title?: string;
  fields?: FieldSpec[];
  extra?: Record<string, unknown>;
  initial?: Record<string, unknown>;
};

/** The "Add assessment" choices, grouped Skills / Standardized / Other. AFLS lists each module. */
export function addOptions(catalog: Catalog, clientId: string, today: string) {
  return ASSESSMENT_GROUPS.map((g) => ({
    label: GROUP_LABELS[g],
    options: catalog.types
      .filter((t) => t.group === g)
      .flatMap((t): AddOption[] => {
        if (t.entry === "vbmapp_import")
          return [
            { value: t.key, label: `${t.name} (import workbook)`, href: `/clients/${clientId}/vbmapp` },
          ];
        const mods = t.modules.length ? t.modules.map((m) => ({ key: m.key, name: m.name })) : [null];
        return mods.map((m) => ({
          value: m ? `${t.key}:${m.key}` : t.key,
          label: m ? `${t.name}: ${m.name}` : t.name,
          title: m ? `Add ${t.name}: ${m.name}` : `Add ${t.name}`,
          fields: assessmentFields(t, m?.key ?? null),
          extra: { typeKey: t.key, module: m?.key ?? null },
          initial: {
            administeredOn: today,
            scores: initialRows(t, m?.key ?? null),
            customScales: t.key === "other" ? [{ name: "", kind: "", value: "", possible: "" }] : [],
          },
        }));
      }),
  })).filter((g) => g.options.length);
}

/** Form values for editing a draft: catalog scales as rows, added scales separately. */
export function editValues(catalog: Catalog, item: AssessmentItem): Record<string, unknown> {
  const t = catalogType(catalog, item.typeKey);
  const known = t ? scalesFor(t, item.module).map((s) => s.key) : [];
  return {
    administeredOn: item.administeredOn ?? "",
    administeredBy: item.administeredBy ?? "",
    form: item.form ?? "",
    respondent: item.respondent ?? "",
    customName: item.customName ?? "",
    notes: item.notes ?? "",
    scores: item.scores
      .filter((s) => known.includes(s.key))
      .map((s) => ({
        scaleKey: s.key,
        value: s.value,
        ...(takesPossible(t ? scalesFor(t, item.module) : []) ? { possible: s.possible ?? "" } : {}),
      })),
    customScales: item.scores
      .filter((s) => !known.includes(s.key))
      .map((s) => ({ name: s.name, kind: s.kind, value: s.value, possible: s.possible ?? "" })),
  };
}
