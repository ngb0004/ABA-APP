import { z } from "zod";
import { api, readJson } from "@/lib/server/api";
import { asOfToday } from "@/lib/server/as-of";
import { editSection } from "@/lib/services/plans";

export const PUT = api<{ id: string; key: string }>(async (req, ctx, { id, key }) => {
  const { content } = await readJson(req, z.object({ content: z.string().max(20000) }));
  return editSection(ctx, id, key, content, asOfToday());
});
