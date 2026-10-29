import { api } from "@/lib/server/api";
import { approveGoal } from "@/lib/services/plans";

export const POST = api<{ id: string }>(async (_req, ctx, { id }) => approveGoal(ctx, id));
