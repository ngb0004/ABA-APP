import { GoalPatchSchema } from "@/lib/goals/goal-patch";
import { api, readJson } from "@/lib/server/api";
import { removeGoal, updateGoal } from "@/lib/services/plans";

/**
 * Saves only the fields sent (the editors autosave what changed). Each field names the value it
 * was based on; a field someone else changed meanwhile is a 409 with the current values.
 */
export const PATCH = api<{ id: string }>(async (req, ctx, { id }) => {
  const { base, baseAlt, ...patch } = await readJson(req, GoalPatchSchema);
  return updateGoal(ctx, id, patch, { base, baseAlt });
});

/** Only a goal added by mistake (no data, never approved or exported); otherwise 409: discontinue it instead. */
export const DELETE = api<{ id: string }>(async (_req, ctx, { id }) => removeGoal(ctx, id));
