import { ApproveGoalSchema } from "@/lib/goals/goal-patch";
import { api, readJson } from "@/lib/server/api";
import { approveGoal } from "@/lib/services/plans";

/** Approves what the approver was shown (`expected`); a goal that changed since is a 409. */
export const POST = api<{ id: string }>(async (req, ctx, { id }) => {
  const { expected } = await readJson(req, ApproveGoalSchema);
  return approveGoal(ctx, id, { expected });
});
