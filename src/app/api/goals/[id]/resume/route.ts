import { api } from "@/lib/server/api";
import { resumeGoal } from "@/lib/services/plans";

export const POST = api<{ id: string }>(async (_req, ctx, { id }) => resumeGoal(ctx, id));
