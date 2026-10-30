import { api } from "@/lib/server/api";
import { deleteSession } from "@/lib/services/records";

export const DELETE = api<{ id: string; rowId: string }>(async (_req, ctx, { id, rowId }) =>
  deleteSession(ctx, id, rowId),
);
