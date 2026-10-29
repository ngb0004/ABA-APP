import { api } from "@/lib/server/api";
import { lockGoalBaseline } from "@/lib/services/plans";

export const POST = api<{ id: string }>(async (_req, ctx, { id }) => lockGoalBaseline(ctx, id));
