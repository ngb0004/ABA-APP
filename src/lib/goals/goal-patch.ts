/**
 * What a goal save may change, checked the same way in the browser (before an autosave is sent)
 * and on the server (PATCH /api/goals/[id]). Every field is optional: a save sends only what changed.
 */
import { z } from "zod";
import { GOAL_STATUSES } from "./status";

// A real calendar date: "2026-02-30" does not survive the round trip.
const Day = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Use a date (YYYY-MM-DD)")
  .refine((s) => {
    const d = new Date(`${s}T00:00:00Z`);
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
  }, "Not a real calendar date");

const Whole = (what: string, min: number, max: number) =>
  z
    .number(`Enter the ${what} as a number`)
    .int(`Use a whole number for the ${what}`)
    .min(min, `The ${what} must be at least ${min}`)
    .max(max, `The ${what} must be ${max} or less`);

export const GOAL_PATCH_FIELDS = {
  objective: z
    .string()
    .refine((s) => s.trim().length > 0, "Write the objective")
    .pipe(z.string().max(4000, "Keep the objective to 4000 characters or fewer")),
  rationale: z
    .string()
    .refine((s) => s.trim().length > 0, "Write the medical necessity rationale")
    .pipe(z.string().max(4000, "Keep the rationale to 4000 characters or fewer")),
  flatExplanation: z.string().max(4000, "Keep the explanation to 4000 characters or fewer").nullable(),
  masteryAccuracyPct: Whole("mastery percentage", 1, 100),
  masteryConsecutiveSessions: Whole("number of consecutive sessions", 1, 50),
  masteryInstructors: Whole("number of instructors", 1, 10),
  introducedAt: Day.nullable(),
  projectedMasteryDate: Day.nullable(),
  progressStatus: z.enum(GOAL_STATUSES, "Choose a status"),
  barriers: z.string().max(4000, "Keep barriers to 4000 characters or fewer"),
  settings: z
    .array(z.string().min(1).max(40, "Keep each setting to 40 characters or fewer"))
    .max(10, "List up to 10 settings"),
} as const;

export type GoalPatchField = keyof typeof GOAL_PATCH_FIELDS;
export type GoalPatch = { [K in GoalPatchField]?: z.infer<(typeof GOAL_PATCH_FIELDS)[K]> };

/** A field's stored value as an editor saw it (any stored value, valid or not). */
const BaseValues = z
  .record(z.string(), z.unknown())
  .refine((m) => Object.keys(m).every((k) => Object.hasOwn(GOAL_PATCH_FIELDS, k)), "Unknown field");

export const GoalPatchSchema = z
  .object(GOAL_PATCH_FIELDS)
  .partial()
  .extend({
    /**
     * What each field sent held when the editor changed it. A field someone else changed
     * meanwhile is refused (409) rather than overwritten; other fields and the goal's bookkeeping
     * (position, plan, approval, baseline) never conflict.
     */
    base: BaseValues,
    /** Also accepted as what a field holds (a save still in flight when the page was left). */
    baseAlt: BaseValues.optional(),
  })
  .refine((v) => Object.keys(v).every((k) => k === "base" || k === "baseAlt" || Object.hasOwn(v.base, k)), {
    message: "Each field saved needs the value it was based on",
    path: ["base"],
  });

export function isGoalPatchField(f: string): f is GoalPatchField {
  return Object.hasOwn(GOAL_PATCH_FIELDS, f);
}

/** The problem with one field's value, in a sentence, or null when it can be saved. */
export function goalFieldProblem(field: GoalPatchField, value: unknown): string | null {
  const r = GOAL_PATCH_FIELDS[field].safeParse(value);
  return r.success ? null : (r.error.issues[0]?.message ?? "Check this value");
}

/** Refused saves: a field was changed somewhere else while it was being edited here. */
export const GOAL_CHANGED_ELSEWHERE =
  "Someone changed this somewhere else while you were editing it. Your text is kept: choose which version to keep.";

/** Refused approvals: the goal says something other than what the approver was shown. */
export const GOAL_CHANGED_BEFORE_APPROVAL =
  "This goal changed since this page showed it, so it was not approved. The latest version is shown; review it and approve again.";

/** What the editors call each field, in status messages. */
export const GOAL_FIELD_LABEL: Record<GoalPatchField, string> = {
  objective: "Objective",
  rationale: "Medical necessity rationale",
  flatExplanation: "Flat-progress explanation",
  masteryAccuracyPct: "Mastery %",
  masteryConsecutiveSessions: "Consecutive sessions",
  masteryInstructors: "Instructors",
  introducedAt: "Introduced",
  projectedMasteryDate: "Projected mastery",
  progressStatus: "Status",
  barriers: "Barriers",
  settings: "Settings",
};

/** Where on the goals page each field is edited. */
export const GOAL_FIELD_HOME: Record<GoalPatchField, string> = {
  objective: "Edit goal, in the goal's menu",
  rationale: "Edit goal, in the goal's menu",
  masteryAccuracyPct: "Edit goal, in the goal's menu",
  masteryConsecutiveSessions: "Edit goal, in the goal's menu",
  masteryInstructors: "Edit goal, in the goal's menu",
  flatExplanation: "the flat-progress explanation",
  introducedAt: "the goal's status and dates",
  projectedMasteryDate: "the goal's status and dates",
  progressStatus: "the goal's status and dates",
  barriers: "the goal's status and dates",
  settings: "the goal's status and dates",
};

/** The fields approving a goal approves: what it says, its mastery criteria, and its dates. */
export const GOAL_APPROVED_FIELDS = [
  "objective",
  "rationale",
  "masteryAccuracyPct",
  "masteryConsecutiveSessions",
  "masteryInstructors",
  "introducedAt",
  "projectedMasteryDate",
] as const satisfies readonly GoalPatchField[];

/** What the approver was shown: approval is refused if the goal now says anything else. */
export const ApproveGoalSchema = z.object({
  expected: z.object({
    objective: z.string(),
    rationale: z.string(),
    masteryAccuracyPct: z.number(),
    masteryConsecutiveSessions: z.number(),
    masteryInstructors: z.number(),
    introducedAt: z.string().nullable(),
    projectedMasteryDate: z.string().nullable(),
  }),
});
export type ApprovedGoalValues = z.infer<typeof ApproveGoalSchema>["expected"];

/** A goal's stored values in the form the editors save them (dates as YYYY-MM-DD). */
export function storedGoalValues(g: {
  objective: string;
  rationale: string;
  flatExplanation: string | null;
  masteryAccuracyPct: number;
  masteryConsecutiveSessions: number;
  masteryInstructors: number;
  introducedAt: Date | null;
  projectedMasteryDate: Date | null;
  progressStatus: string;
  barriers: string;
  settings: unknown;
}): Record<GoalPatchField, unknown> {
  const day = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : null);
  return {
    objective: g.objective,
    rationale: g.rationale,
    flatExplanation: g.flatExplanation,
    masteryAccuracyPct: g.masteryAccuracyPct,
    masteryConsecutiveSessions: g.masteryConsecutiveSessions,
    masteryInstructors: g.masteryInstructors,
    introducedAt: day(g.introducedAt),
    projectedMasteryDate: day(g.projectedMasteryDate),
    progressStatus: g.progressStatus,
    barriers: g.barriers,
    settings: Array.isArray(g.settings) ? g.settings : [],
  };
}
