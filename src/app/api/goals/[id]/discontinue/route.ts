import { z } from "zod";
import { api, readJson } from "@/lib/server/api";
import { asOfToday } from "@/lib/server/as-of";
import { DISCONTINUE_REASON_MAX, discontinueGoal } from "@/lib/services/plans";

const Body = z.object({
  reason: z
    .string()
    .trim()
    .min(1, "Say why the goal is being discontinued")
    .max(DISCONTINUE_REASON_MAX, `Keep the reason to ${DISCONTINUE_REASON_MAX} characters or fewer`),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use a date (YYYY-MM-DD)"),
});

export const POST = api<{ id: string }>(async (req, ctx, { id }) =>
  discontinueGoal(ctx, id, await readJson(req, Body), asOfToday()),
);
