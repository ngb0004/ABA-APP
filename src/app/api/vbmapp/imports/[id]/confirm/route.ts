import { z } from "zod";
import { api, readJson } from "@/lib/server/api";
import { confirmImport } from "@/lib/services/vbmapp";

export const POST = api<{ id: string }>(async (req, ctx, { id }) =>
  confirmImport(ctx, id, await readJson(req, z.object({ stripPhi: z.boolean() }))),
);
