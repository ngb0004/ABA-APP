import { z } from "zod";
import { api, readJson } from "@/lib/server/api";
import { addGoalFromTemplate } from "@/lib/services/misc";

export const POST = api<{ id: string }>(async (req, ctx, { id }) => {
  const { templateId } = await readJson(req, z.object({ templateId: z.string().uuid() }));
  const g = await addGoalFromTemplate(ctx, id, templateId);
  return { goalId: g.id };
});
