import { z } from "zod";
import { api, readJson } from "@/lib/server/api";
import { revokeRuleVerification } from "@/lib/services/rules-watch";

export const POST = api<{ id: string }>(async (req, ctx, { id }) => {
  const { note } = await readJson(req, z.object({ note: z.string().max(1000).nullable().optional() }));
  const ev = await revokeRuleVerification(ctx, id, note ?? null);
  return { evidenceId: ev.id };
});
