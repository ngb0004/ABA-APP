import { z } from "zod";
import { api, readJson } from "@/lib/server/api";
import { setSectionItem } from "@/lib/services/plans";

const Body = z.object({
  itemKey: z.string().min(1).max(200),
  status: z.enum(["answered", "none"]).nullable(),
  note: z.string().max(1000).optional(),
});

export const POST = api<{ id: string; key: string }>(async (req, ctx, { id, key }) => {
  const b = await readJson(req, Body);
  return setSectionItem(ctx, id, key, b.itemKey, b.status, b.note);
});
