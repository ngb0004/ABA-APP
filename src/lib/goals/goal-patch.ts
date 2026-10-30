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

export const GoalPatchSchema = z
  .object(GOAL_PATCH_FIELDS)
  .partial()
  .extend({
    /** The version (updatedAt) the editor started from; a save against an older version is refused. */
    expectedUpdatedAt: z.iso.datetime({ offset: true }).optional(),
  });

export function isGoalPatchField(f: string): f is GoalPatchField {
  return Object.hasOwn(GOAL_PATCH_FIELDS, f);
}

/** The problem with one field's value, in a sentence, or null when it can be saved. */
export function goalFieldProblem(field: GoalPatchField, value: unknown): string | null {
  const r = GOAL_PATCH_FIELDS[field].safeParse(value);
  return r.success ? null : (r.error.issues[0]?.message ?? "Check this value");
}

/** Refused saves: the goal changed since the editor loaded it. */
export const GOAL_CHANGED_ELSEWHERE =
  "This goal was changed somewhere else since you opened it, so this change was not saved. The latest version is shown.";
