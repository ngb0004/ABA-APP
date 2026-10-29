import { api } from "@/lib/server/api";
import { discardImport } from "@/lib/services/vbmapp";

export const POST = api<{ id: string }>(async (_req, ctx, { id }) => discardImport(ctx, id));
