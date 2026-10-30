import { api, readJson } from "@/lib/server/api";
import { addSession } from "@/lib/services/records";

const Any = { parse: (x: unknown) => x };

export const POST = api<{ id: string }>(async (req, ctx, { id }) =>
  addSession(ctx, id, await readJson(req, Any)),
);
