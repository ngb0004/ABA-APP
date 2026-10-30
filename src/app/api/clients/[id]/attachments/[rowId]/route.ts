import { api, readJson } from "@/lib/server/api";
import { deleteAttachment, saveAttachment } from "@/lib/services/records";

const Any = { parse: (x: unknown) => x };

export const PUT = api<{ id: string; rowId: string }>(async (req, ctx, { id, rowId }) =>
  saveAttachment(ctx, id, rowId, await readJson(req, Any)),
);
export const DELETE = api<{ id: string; rowId: string }>(async (_req, ctx, { id, rowId }) =>
  deleteAttachment(ctx, id, rowId),
);
