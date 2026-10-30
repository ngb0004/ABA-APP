import { api } from "@/lib/server/api";
import { confirmAssessment } from "@/lib/services/assessments";

export const POST = api<{ id: string; rowId: string }>(async (_req, ctx, { id, rowId }) =>
  confirmAssessment(ctx, id, rowId),
);
