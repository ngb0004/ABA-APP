import { api } from "@/lib/server/api";
import { reopenSection } from "@/lib/services/plans";

export const POST = api<{ id: string; key: string }>(async (_req, ctx, { id, key }) =>
  reopenSection(ctx, id, key),
);
