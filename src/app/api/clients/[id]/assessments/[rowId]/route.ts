import { api, readJson } from "@/lib/server/api";
import { asOfToday } from "@/lib/server/as-of";
import { deleteAssessment, updateAssessment } from "@/lib/services/assessments";

const Any = { parse: (x: unknown) => x };

export const PUT = api<{ id: string; rowId: string }>(async (req, ctx, { id, rowId }) =>
  updateAssessment(ctx, id, rowId, await readJson(req, Any), asOfToday()),
);
export const DELETE = api<{ id: string; rowId: string }>(async (_req, ctx, { id, rowId }) =>
  deleteAssessment(ctx, id, rowId),
);
