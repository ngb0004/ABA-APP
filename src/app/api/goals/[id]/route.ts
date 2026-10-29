import { z } from "zod";
import { GOAL_STATUSES } from "@/lib/plan/context";
import { api, readJson } from "@/lib/server/api";
import { updateGoal } from "@/lib/services/plans";

const Day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use a date (YYYY-MM-DD)");

const Body = z
  .object({
    objective: z.string().min(1).max(4000),
    rationale: z.string().min(1).max(4000),
    flatExplanation: z.string().max(4000).nullable(),
    masteryAccuracyPct: z.number().int().min(1).max(100),
    masteryConsecutiveSessions: z.number().int().min(1).max(50),
    masteryInstructors: z.number().int().min(1).max(10),
    introducedAt: Day.nullable(),
    projectedMasteryDate: Day.nullable(),
    progressStatus: z.enum(GOAL_STATUSES),
    barriers: z.string().max(4000),
    settings: z.array(z.string().min(1).max(40)).max(10),
  })
  .partial();

export const PATCH = api<{ id: string }>(async (req, ctx, { id }) =>
  updateGoal(ctx, id, await readJson(req, Body)),
);
