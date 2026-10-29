import { api } from "@/lib/server/api";
import { asOfToday } from "@/lib/server/as-of";
import { approveSection } from "@/lib/services/plans";

export const POST = api<{ id: string; key: string }>(async (_req, ctx, { id, key }) => {
  const s = await approveSection(ctx, id, key, asOfToday());
  return { state: s.state };
});
