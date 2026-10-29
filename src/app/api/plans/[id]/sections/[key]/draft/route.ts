import { api } from "@/lib/server/api";
import { asOfToday } from "@/lib/server/as-of";
import { draftSection } from "@/lib/services/plans";

export const POST = api<{ id: string; key: string }>(async (_req, ctx, { id, key }) =>
  draftSection(ctx, id, key, asOfToday()),
);
