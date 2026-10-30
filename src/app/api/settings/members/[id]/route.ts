import { api, readJson } from "@/lib/server/api";
import { changeMemberRole, removeMember } from "@/lib/services/records";

const Any = { parse: (x: unknown) => x };

export const PATCH = api<{ id: string }>(async (req, ctx, { id }) =>
  changeMemberRole(ctx, id, ((await readJson(req, Any)) as { role?: unknown }).role),
);
export const DELETE = api<{ id: string }>(async (_req, ctx, { id }) => removeMember(ctx, id));
