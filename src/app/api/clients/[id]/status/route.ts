import { api, readJson } from "@/lib/server/api";
import { asOfToday } from "@/lib/server/as-of";
import { ClientStatusInput, setClientStatus } from "@/lib/services/client-status";

/** Mark the client inactive (date, reason, optional note) or active again. BCBA only. */
export const POST = api<{ id: string }>(async (req, ctx, { id }) =>
  setClientStatus(ctx, id, await readJson(req, ClientStatusInput), asOfToday()),
);
