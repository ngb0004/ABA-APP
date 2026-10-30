import { api, readJson } from "@/lib/server/api";
import { updateClient } from "@/lib/services/records";

const Any = { parse: (x: unknown) => x };

export const PATCH = api<{ id: string }>(async (req, ctx, { id }) =>
  updateClient(ctx, id, await readJson(req, Any)),
);
