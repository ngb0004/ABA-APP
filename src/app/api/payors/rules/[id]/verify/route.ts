import { z } from "zod";
import { api, readJson } from "@/lib/server/api";
import { setRuleVerified } from "@/lib/services/misc";

export const POST = api<{ id: string }>(async (req, ctx, { id }) => {
  const b = await readJson(req, z.object({ verified: z.boolean(), section: z.string().max(200).nullable() }));
  return setRuleVerified(ctx, id, b.verified, b.section);
});
