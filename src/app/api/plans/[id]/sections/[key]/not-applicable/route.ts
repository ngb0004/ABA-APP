import { z } from "zod";
import { api, readJson } from "@/lib/server/api";
import { markSectionNotApplicable } from "@/lib/services/plans";

const Body = z.object({ reason: z.string().min(1).max(500) });

export const POST = api<{ id: string; key: string }>(async (req, ctx, { id, key }) =>
  markSectionNotApplicable(ctx, id, key, (await readJson(req, Body)).reason),
);
