import { api, readJson } from "@/lib/server/api";
import { asOfToday } from "@/lib/server/as-of";
import { saveAttachment } from "@/lib/services/records";

const Any = { parse: (x: unknown) => x };

export const POST = api<{ id: string }>(async (req, ctx, { id }) =>
  saveAttachment(ctx, id, null, await readJson(req, Any), asOfToday()),
);
