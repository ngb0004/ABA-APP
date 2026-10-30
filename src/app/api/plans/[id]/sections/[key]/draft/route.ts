import { api } from "@/lib/server/api";
import { asOfToday } from "@/lib/server/as-of";
import { draftSection } from "@/lib/services/plans";

// A draft is one or two model calls (the firewall retries once); allow for slow responses.
export const maxDuration = 120;

export const POST = api<{ id: string; key: string }>(async (_req, ctx, { id, key }) =>
  draftSection(ctx, id, key, asOfToday()),
);
