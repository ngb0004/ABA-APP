import { api, readJson } from "@/lib/server/api";
import { asOfToday } from "@/lib/server/as-of";
import { createAssessment } from "@/lib/services/assessments";

const Any = { parse: (x: unknown) => x };

export const POST = api<{ id: string }>(async (req, ctx, { id }) =>
  createAssessment(ctx, id, await readJson(req, Any), asOfToday()),
);
