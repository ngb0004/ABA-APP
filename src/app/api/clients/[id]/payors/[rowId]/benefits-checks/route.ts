import { api, readJson } from "@/lib/server/api";
import { asOfToday } from "@/lib/server/as-of";
import { saveBenefitsCheck } from "@/lib/services/records";

const Any = { parse: (x: unknown) => x };

export const POST = api<{ id: string; rowId: string }>(async (req, ctx, { id, rowId }) =>
  saveBenefitsCheck(ctx, id, rowId, await readJson(req, Any), asOfToday()),
);
