import { api } from "@/lib/server/api";
import { resetPlanAssessments } from "@/lib/services/plans";

/** Reset the plan's assessments to the default selection (the window in force now). */
export const POST = api<{ id: string }>(async (_req, ctx, { id }) => resetPlanAssessments(ctx, id));
