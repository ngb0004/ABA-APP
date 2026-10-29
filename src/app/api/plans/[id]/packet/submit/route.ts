import { api } from "@/lib/server/api";
import { markSubmitted } from "@/lib/services/packets";

export const POST = api<{ id: string }>(async (_req, ctx, { id }) => markSubmitted(ctx, id));
