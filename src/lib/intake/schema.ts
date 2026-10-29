/**
 * Parent intake schema. Every field carries a sensitivity tag and the plan
 * sections it feeds. Every field accepts an explicit "none / not applicable"
 * answer; blank is not allowed at submission.
 */
import { z } from "zod";
import type { Sensitivity } from "../sensitivity";

export const LIKERT = ["never", "rarely", "sometimes", "often", "always"] as const;
export const INTENSITY = ["mild", "moderate", "severe"] as const;
export const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
/** Two-hour availability blocks: [startHour, endHour]. */
export const BLOCKS = [
  [8, 10],
  [10, 12],
  [12, 14],
  [14, 16],
  [16, 18],
] as const;

export type FieldType =
  | "yes_no"
  | "likert"
  | "checklist"
  | "select"
  | "intensity"
  | "frequency_duration"
  | "date"
  | "text"
  | "medication_table"
  | "prior_evaluation_table"
  | "availability_grid";

export type SectionKey =
  | "identifying"
  | "background"
  | "assessment"
  | "behavior"
  | "skill_goals"
  | "behavior_goals"
  | "caregiver"
  | "services"
  | "coordination"
  | "crisis"
  | "transition";

export type IntakeField = {
  id: string;
  label: string;
  type: FieldType;
  group: string;
  sensitivity: Sensitivity;
  feeds_sections: SectionKey[];
  options?: readonly string[];
  /** Only asked when the client is at least this age (years). */
  minAge?: number;
  /** Yes/no fields: answering yes raises this staff safety flag. */
  safetyFlag?: string;
};

const f = (x: IntakeField) => x;

export const INTAKE_FIELDS: IntakeField[] = [
  // Background and medical
  f({
    id: "primary_concerns",
    label: "Primary concerns in the family's words",
    type: "text",
    group: "Background",
    sensitivity: "sensitive",
    feeds_sections: ["background", "skill_goals"],
  }),
  f({
    id: "diagnosis_date",
    label: "Date of autism diagnosis",
    type: "date",
    group: "Background",
    sensitivity: "sensitive",
    feeds_sections: ["background"],
  }),
  f({
    id: "diagnosing_provider_type",
    label: "Diagnosing provider type",
    type: "select",
    group: "Background",
    sensitivity: "normal",
    feeds_sections: ["background"],
    options: ["Developmental pediatrician", "Psychologist", "Psychiatrist", "Neurologist", "Other"],
  }),
  f({
    id: "medications",
    label: "Current medications",
    type: "medication_table",
    group: "Medical",
    sensitivity: "sensitive",
    feeds_sections: ["background", "crisis"],
  }),
  f({
    id: "severe_allergy",
    label: "Severe allergy",
    type: "yes_no",
    group: "Medical",
    sensitivity: "sensitive",
    feeds_sections: ["crisis"],
    safetyFlag: "Severe allergy",
  }),
  f({
    id: "epipen",
    label: "Carries an epinephrine auto-injector",
    type: "yes_no",
    group: "Medical",
    sensitivity: "sensitive",
    feeds_sections: ["crisis"],
    safetyFlag: "Epi-pen",
  }),
  f({
    id: "inhaler",
    label: "Uses an inhaler",
    type: "yes_no",
    group: "Medical",
    sensitivity: "sensitive",
    feeds_sections: ["crisis"],
    safetyFlag: "Inhaler",
  }),
  f({
    id: "seizures",
    label: "History of seizures",
    type: "yes_no",
    group: "Medical",
    sensitivity: "sensitive",
    feeds_sections: ["background", "crisis"],
    safetyFlag: "Seizures",
  }),
  f({
    id: "sleep_difficulty",
    label: "Difficulty falling or staying asleep",
    type: "likert",
    group: "Medical",
    sensitivity: "normal",
    feeds_sections: ["background"],
    options: LIKERT,
  }),
  f({
    id: "feeding_concerns",
    label: "Feeding or restricted-diet concerns",
    type: "yes_no",
    group: "Medical",
    sensitivity: "normal",
    feeds_sections: ["background", "skill_goals"],
  }),
  f({
    id: "toileting_status",
    label: "Toileting status",
    type: "select",
    group: "Daily living",
    sensitivity: "normal",
    feeds_sections: ["skill_goals"],
    options: [
      "Not toilet trained",
      "Trained with frequent accidents",
      "Trained with occasional accidents",
      "Fully trained",
    ],
  }),
  f({
    id: "communication_modes",
    label: "How the child communicates",
    type: "checklist",
    group: "Communication",
    sensitivity: "normal",
    feeds_sections: ["background", "skill_goals"],
    options: [
      "Vocal words",
      "Vocal approximations",
      "Sign",
      "Picture exchange",
      "Speech-generating device",
      "Leading adults",
      "Crying or gestures",
    ],
  }),
  // Behavior
  f({
    id: "aggression",
    label: "Aggression toward others",
    type: "intensity",
    group: "Behavior",
    sensitivity: "normal",
    feeds_sections: ["behavior", "behavior_goals"],
    options: INTENSITY,
  }),
  f({
    id: "aggression_frequency",
    label: "Aggression frequency and typical duration",
    type: "frequency_duration",
    group: "Behavior",
    sensitivity: "normal",
    feeds_sections: ["behavior", "behavior_goals"],
  }),
  f({
    id: "self_injury",
    label: "Self-injurious behavior",
    type: "intensity",
    group: "Behavior",
    sensitivity: "normal",
    feeds_sections: ["behavior", "behavior_goals", "crisis"],
    options: INTENSITY,
  }),
  f({
    id: "tantrums",
    label: "Tantrum frequency and typical duration",
    type: "frequency_duration",
    group: "Behavior",
    sensitivity: "normal",
    feeds_sections: ["behavior", "behavior_goals"],
  }),
  f({
    id: "transitions_difficulty",
    label: "Difficulty with transitions between activities",
    type: "likert",
    group: "Behavior",
    sensitivity: "normal",
    feeds_sections: ["behavior"],
    options: LIKERT,
  }),
  // Safety
  f({
    id: "bolting",
    label: "Bolting or running away from adults",
    type: "yes_no",
    group: "Safety",
    sensitivity: "normal",
    feeds_sections: ["behavior", "crisis"],
    safetyFlag: "Bolting / elopement",
  }),
  f({
    id: "overnight_wandering",
    label: "Wanders from the home overnight",
    type: "yes_no",
    group: "Safety",
    sensitivity: "normal",
    feeds_sections: ["crisis"],
    safetyFlag: "Overnight wandering",
  }),
  f({
    id: "pica",
    label: "Eats non-food items (pica)",
    type: "yes_no",
    group: "Safety",
    sensitivity: "normal",
    feeds_sections: ["behavior", "crisis"],
    safetyFlag: "Pica",
  }),
  f({
    id: "transportation_risks",
    label: "Transportation safety risks",
    type: "checklist",
    group: "Safety",
    sensitivity: "normal",
    feeds_sections: ["crisis"],
    options: [
      "Unbuckles seat belt",
      "Opens car door while moving",
      "Runs in parking lots",
      "Refuses to enter vehicle",
    ],
  }),
  // School and prior services
  f({
    id: "school_placement",
    label: "School or daycare placement",
    type: "text",
    group: "School",
    sensitivity: "normal",
    feeds_sections: ["background", "coordination"],
  }),
  f({
    id: "has_iep",
    label: "Has an IEP or IFSP",
    type: "yes_no",
    group: "School",
    sensitivity: "normal",
    feeds_sections: ["coordination"],
  }),
  f({
    id: "prior_evaluations",
    label: "Prior evaluations",
    type: "prior_evaluation_table",
    group: "Prior services",
    sensitivity: "sensitive",
    feeds_sections: ["background", "assessment"],
  }),
  f({
    id: "other_therapies",
    label: "Other current therapies (speech, OT, PT)",
    type: "checklist",
    group: "Prior services",
    sensitivity: "normal",
    feeds_sections: ["coordination"],
    options: ["Speech therapy", "Occupational therapy", "Physical therapy", "Feeding therapy", "Counseling"],
  }),
  // Adolescent-only
  f({
    id: "independent_community",
    label: "Goes into the community without an adult",
    type: "yes_no",
    group: "Adolescent",
    sensitivity: "normal",
    feeds_sections: ["skill_goals", "crisis"],
    minAge: 12,
  }),
  f({
    id: "substance_use",
    label: "Substance use concerns",
    type: "yes_no",
    group: "Adolescent",
    sensitivity: "restricted",
    feeds_sections: ["background"],
    minAge: 12,
  }),
  // Restricted: never sent to the AI. The BCBA writes these statements.
  f({
    id: "abuse_history",
    label: "History of abuse or neglect",
    type: "yes_no",
    group: "Family (restricted)",
    sensitivity: "restricted",
    feeds_sections: ["background"],
  }),
  f({
    id: "suicidal_behavior",
    label: "Suicidal statements or behavior",
    type: "yes_no",
    group: "Family (restricted)",
    sensitivity: "restricted",
    feeds_sections: ["crisis"],
  }),
  f({
    id: "family_psychiatric_history",
    label: "Family psychiatric history",
    type: "yes_no",
    group: "Family (restricted)",
    sensitivity: "restricted",
    feeds_sections: ["background"],
  }),
  f({
    id: "custody_arrangement",
    label: "Custody arrangement",
    type: "select",
    group: "Family (restricted)",
    sensitivity: "restricted",
    feeds_sections: ["identifying"],
    options: ["Joint legal custody", "Sole legal custody", "Legal guardian (non-parent)", "State custody"],
  }),
  // Caregiver and scheduling
  f({
    id: "caregiver_priorities",
    label: "Caregiver priorities for treatment",
    type: "text",
    group: "Caregiver",
    sensitivity: "normal",
    feeds_sections: ["caregiver", "skill_goals"],
  }),
  f({
    id: "caregiver_training_availability",
    label: "Caregiver available for parent training",
    type: "yes_no",
    group: "Caregiver",
    sensitivity: "normal",
    feeds_sections: ["caregiver", "services"],
  }),
  f({
    id: "availability",
    label: "Weekly availability for sessions",
    type: "availability_grid",
    group: "Scheduling",
    sensitivity: "normal",
    feeds_sections: ["services"],
  }),
];

export const FIELD_BY_ID = new Map(INTAKE_FIELDS.map((x) => [x.id, x]));

// ---------------------------------------------------------------- answer schemas

const NA = z.object({ na: z.literal(true), note: z.string().max(500).optional() });
const comment = z.string().max(2000).optional();
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

const valueSchemas: Record<FieldType, z.ZodTypeAny> = {
  yes_no: z.object({ value: z.boolean(), comment }),
  likert: z.object({ value: z.enum(LIKERT), comment }),
  checklist: z.object({ value: z.array(z.string()).min(1), comment }),
  select: z.object({ value: z.string().min(1), comment }),
  intensity: z.object({ value: z.enum(INTENSITY), comment }),
  frequency_duration: z.object({
    value: z.object({
      count: z.number().int().min(0).max(1000),
      per: z.enum(["day", "week", "month"]),
      durationMinutes: z.number().min(0).max(600),
    }),
    comment,
  }),
  date: z.object({ value: isoDate, comment }),
  text: z.object({ value: z.string().trim().min(1).max(5000) }),
  medication_table: z.object({
    value: z
      .array(z.object({ name: z.string().min(1), dose: z.string().min(1), purpose: z.string().min(1) }))
      .min(1),
  }),
  prior_evaluation_table: z.object({
    value: z.array(z.object({ type: z.string().min(1), provider: z.string().min(1), date: isoDate })).min(1),
  }),
  availability_grid: z.object({
    /** day → list of available block indexes into BLOCKS */
    value: z.partialRecord(
      z.enum(DAYS),
      z.array(
        z
          .number()
          .int()
          .min(0)
          .max(BLOCKS.length - 1),
      ),
    ),
  }),
};

export function answerSchemaFor(field: IntakeField) {
  let s = valueSchemas[field.type];
  if (field.options && (field.type === "select" || field.type === "checklist")) {
    const opts = new Set(field.options);
    s = s.refine(
      (a) => [(a as { value: string | string[] }).value].flat().every((v) => opts.has(v)),
      "Not one of the listed options",
    );
  }
  return z.union([NA, s]);
}

export type IntakeAnswer = { na: true; note?: string } | { value: unknown; comment?: string };
export type IntakeAnswers = Record<string, IntakeAnswer>;

export function applicableFields(ageYears: number): IntakeField[] {
  return INTAKE_FIELDS.filter((x) => x.minAge === undefined || ageYears >= x.minAge);
}

export type IntakeIssue = { fieldId: string; message: string };

/** Draft validation: what's present must be well-formed. */
export function validateDraft(answers: unknown): {
  ok: boolean;
  issues: IntakeIssue[];
  answers: IntakeAnswers;
} {
  const issues: IntakeIssue[] = [];
  const parsed = z.record(z.string(), z.unknown()).safeParse(answers);
  if (!parsed.success)
    return { ok: false, issues: [{ fieldId: "*", message: "Answers must be an object" }], answers: {} };
  const out: IntakeAnswers = {};
  for (const [id, a] of Object.entries(parsed.data)) {
    const field = FIELD_BY_ID.get(id);
    if (!field) {
      issues.push({ fieldId: id, message: "Unknown field" });
      continue;
    }
    const r = answerSchemaFor(field).safeParse(a);
    if (!r.success) issues.push({ fieldId: id, message: r.error.issues[0]?.message ?? "Invalid answer" });
    else out[id] = r.data as IntakeAnswer;
  }
  return { ok: issues.length === 0, issues, answers: out };
}

/** Submission validation: every applicable field must be answered or explicitly marked none / N/A. */
export function validateSubmission(answers: unknown, ageYears: number) {
  const draft = validateDraft(answers);
  const issues = [...draft.issues];
  for (const field of applicableFields(ageYears)) {
    if (!(field.id in draft.answers) && !issues.some((i) => i.fieldId === field.id))
      issues.push({ fieldId: field.id, message: "Required: answer or mark none / not applicable" });
  }
  return { ok: issues.length === 0, issues, answers: draft.answers };
}

export const isNa = (a: IntakeAnswer | undefined): a is { na: true } => !!a && "na" in a && a.na === true;
export const valueOf = <T = unknown>(a: IntakeAnswer | undefined): T | undefined =>
  a && !isNa(a) ? ((a as { value: T }).value as T) : undefined;
