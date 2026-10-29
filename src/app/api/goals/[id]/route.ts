import { z } from "zod";
import { api, readJson } from "@/lib/server/api";
import { updateGoal } from "@/lib/services/plans";

const Body = z
  .object({
    objective: z.string().min(1).max(4000),
    rationale: z.string().min(1).max(4000),
    flatExplanation: z.string().max(4000).nullable(),
    masteryAccuracyPct: z.number().int().min(1).max(100),
    masteryConsecutiveSessions: z.number().int().min(1).max(50),
    masteryInstructors: z.number().int().min(1).max(10),
  })
  .partial();

export const PATCH = api<{ id: string }>(async (req, ctx, { id }) =>
  updateGoal(ctx, id, await readJson(req, Body)),
);
