import { api } from "@/lib/server/api";
import { deleteDataPoint } from "@/lib/services/records";

export const DELETE = api<{ id: string; rowId: string }>(async (_req, ctx, { id, rowId }) =>
  deleteDataPoint(ctx, id, rowId),
);
