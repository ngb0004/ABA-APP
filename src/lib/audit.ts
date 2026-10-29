import type { Prisma } from "@prisma/client";
import { createHash } from "node:crypto";
import { currentCtx, db, type Tx } from "./db";

/**
 * Explicit, semantic audit events (login, approve, AI call, export...).
 * Data reads/writes are audited automatically by withOrg(). Meta must hold IDs
 * and hashes only, never PHI.
 */
export async function audit(
  tx: Tx | null,
  e: {
    action: string;
    entityType: string;
    entityId?: string | null;
    meta?: Prisma.InputJsonValue;
    orgId?: string | null;
    userId?: string | null;
  },
) {
  const ctx = currentCtx();
  const client = tx ?? db();
  // createMany issues no RETURNING, so org-less auth events are not blocked by the SELECT policy.
  await client.auditEvent.createMany({
    data: {
      orgId: e.orgId !== undefined ? e.orgId : (ctx?.orgId ?? null),
      userId: e.userId !== undefined ? e.userId : (ctx?.userId ?? null),
      action: e.action,
      entityType: e.entityType,
      entityId: e.entityId ?? null,
      meta: e.meta ?? {},
    },
  });
}

export function sha256(s: string | Buffer): string {
  return createHash("sha256").update(s).digest("hex");
}
