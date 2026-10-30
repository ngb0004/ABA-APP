import { api } from "@/lib/server/api";
import { discardAssessmentImport } from "@/lib/services/assessment-imports";

export const POST = api<{ id: string }>(async (_req, ctx, { id }) => discardAssessmentImport(ctx, id));
