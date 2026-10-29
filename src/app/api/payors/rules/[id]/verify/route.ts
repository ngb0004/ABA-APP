import { z } from "zod";
import { api, readJson } from "@/lib/server/api";
import { verifyRuleWithQuote } from "@/lib/services/rules-watch";

const Body = z.object({
  quote: z.string().min(1).max(4000),
  section: z.string().max(200).nullable().optional(),
  documentId: z.string().uuid().nullable().optional(),
  note: z.string().max(1000).nullable().optional(),
});

export const POST = api<{ id: string }>(async (req, ctx, { id }) => {
  const ev = await verifyRuleWithQuote(ctx, id, await readJson(req, Body));
  return { evidenceId: ev.id };
});
