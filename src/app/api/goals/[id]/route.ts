import { GoalPatchSchema } from "@/lib/goals/goal-patch";
import { api, readJson } from "@/lib/server/api";
import { removeGoal, updateGoal } from "@/lib/services/plans";

/** Saves only the fields sent (the editors autosave what changed). A stale expectedUpdatedAt is a 409. */
export const PATCH = api<{ id: string }>(async (req, ctx, { id }) => {
  const { expectedUpdatedAt, ...patch } = await readJson(req, GoalPatchSchema);
  return updateGoal(ctx, id, patch, { expectedUpdatedAt });
});

/** Only a goal added by mistake (no data, never approved or exported); otherwise 409: discontinue it instead. */
export const DELETE = api<{ id: string }>(async (_req, ctx, { id }) => removeGoal(ctx, id));
