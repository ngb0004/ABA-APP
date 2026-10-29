import { z } from "zod";
import { api, readJson } from "@/lib/server/api";
import { setChecklistDone } from "@/lib/services/packets";

export const POST = api<{ id: string }>(async (req, ctx, { id }) => {
  const b = await readJson(req, z.object({ key: z.string().min(1).max(300), done: z.boolean() }));
  return setChecklistDone(ctx, id, b.key, b.done);
});
