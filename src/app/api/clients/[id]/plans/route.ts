import { z } from "zod";
import { api, readJson } from "@/lib/server/api";
import { createPlan } from "@/lib/services/plans";

export const POST = api<{ id: string }>(async (req, ctx, { id }) => {
  const { type } = await readJson(req, z.object({ type: z.enum(["initial", "reauth"]) }));
  const p = await createPlan(ctx, id, type);
  return { planId: p.id };
});
