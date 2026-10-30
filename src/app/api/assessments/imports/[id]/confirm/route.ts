import { api, readJson } from "@/lib/server/api";
import { ConfirmImportSchema, confirmAssessmentImport } from "@/lib/services/assessment-imports";

export const POST = api<{ id: string }>(async (req, ctx, { id }) =>
  confirmAssessmentImport(ctx, id, await readJson(req, ConfirmImportSchema)),
);
