import { PrismaClient, type Role } from "@prisma/client";
import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Tenant-scoped database access.
 *
 * All client data is read and written through withOrg(), which opens a
 * transaction, sets app.current_org / app.current_user (consumed by the RLS
 * policies), and records an audit row for every operation on a client-data
 * model. Outside withOrg() the RLS policies return no org-scoped rows at all.
 */

export type OrgCtx = {
  orgId: string;
  userId: string | null;
  role: Role | null;
  /** Yoma staff curating the payor rule library (not an org role). For display; services re-check it. */
  isPlatformCurator?: boolean;
};

type PendingAudit = { action: string; entityType: string; ids: string[] };
type Store = { ctx: OrgCtx; events: PendingAudit[] };
const als = new AsyncLocalStorage<Store>();

/** Models holding client data. Every read and write of these is audited. */
export const AUDITED_MODELS = new Set([
  "Client",
  "Diagnosis",
  "ClientPayor",
  "BenefitsCheck",
  "Attachment",
  "Authorization",
  "AuthorizationUnit",
  "ServiceSession",
  "Intake",
  "VbmappImport",
  "VbmappAdministration",
  "MilestoneScore",
  "Assessment",
  "AssessmentScore",
  "AssessmentImport",
  "Goal",
  "GoalDataPoint",
  "GoalPhaseChange",
  "Plan",
  "PlanSection",
  "PlanSectionRevision",
  "PayorLetter",
  "Packet",
  // Free text from the practice about a rule; audited like client data in case a note slips through.
  "RuleReport",
]);

const READ_OPS = new Set([
  "findUnique",
  "findUniqueOrThrow",
  "findFirst",
  "findFirstOrThrow",
  "findMany",
  "count",
  "aggregate",
  "groupBy",
]);

function collectIds(args: unknown, result: unknown): string[] {
  const ids: string[] = [];
  const push = (v: unknown) => {
    if (typeof v === "string" && ids.length < 50) ids.push(v);
  };
  const where = (args as { where?: { id?: unknown } } | undefined)?.where;
  if (where && typeof where.id === "string") push(where.id);
  if (Array.isArray(result)) for (const r of result) push((r as { id?: unknown })?.id);
  else if (result && typeof result === "object") push((result as { id?: unknown }).id);
  return [...new Set(ids)];
}

function createClient(url?: string) {
  // Minimal error format: Prisma errors must not carry query values into logs.
  const base = new PrismaClient({ ...(url ? { datasourceUrl: url } : {}), errorFormat: "minimal" });
  return base.$extends({
    query: {
      $allModels: {
        async $allOperations({ model, operation, args, query }) {
          const result = await query(args);
          const store = als.getStore();
          if (store && AUDITED_MODELS.has(model)) {
            const kind = READ_OPS.has(operation) ? "read" : "write";
            store.events.push({
              action: `${kind}:${operation}`,
              entityType: model,
              ids: collectIds(args, result),
            });
          }
          return result;
        },
      },
    },
  });
}

export type Db = ReturnType<typeof createClient>;
export type Tx = Omit<Db, "$transaction" | "$connect" | "$disconnect" | "$on" | "$extends">;

const g = globalThis as unknown as { __abaDb?: Db; __abaDbUrl?: string };

export function db(): Db {
  const url = process.env.DATABASE_URL;
  if (!g.__abaDb || g.__abaDbUrl !== url) {
    g.__abaDb = createClient(url);
    g.__abaDbUrl = url;
  }
  return g.__abaDb;
}

/** Run fn with RLS scoped to ctx.orgId. Audit rows for data access are written in the same transaction. */
export async function withOrg<T>(ctx: OrgCtx, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return db().$transaction(
    async (tx) => {
      await tx.$queryRaw`SELECT set_config('app.current_org', ${ctx.orgId}, true), set_config('app.current_user', ${ctx.userId ?? ""}, true)`;
      const store: Store = { ctx, events: [] };
      const result = await als.run(store, () => fn(tx as Tx));
      await flushAudit(tx as Tx, store);
      return result;
    },
    { timeout: 60_000, maxWait: 15_000 },
  );
}

/** Identity-only scope (no org yet), used at login to list a user's memberships. */
export async function withUser<T>(userId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return db().$transaction(async (tx) => {
    await tx.$queryRaw`SELECT set_config('app.current_user', ${userId}, true)`;
    return fn(tx as Tx);
  });
}

export function currentCtx(): OrgCtx | undefined {
  return als.getStore()?.ctx;
}

async function flushAudit(tx: Tx, store: Store) {
  if (!store.events.length) return;
  // Collapse repeated operations on the same model into one row per transaction.
  const grouped = new Map<string, PendingAudit>();
  for (const e of store.events) {
    const key = `${e.action}|${e.entityType}`;
    const prev = grouped.get(key);
    if (prev) prev.ids = [...new Set([...prev.ids, ...e.ids])].slice(0, 50);
    else grouped.set(key, { ...e, ids: [...e.ids] });
  }
  store.events = [];
  await tx.auditEvent.createMany({
    data: [...grouped.values()].map((e) => ({
      orgId: store.ctx.orgId,
      userId: store.ctx.userId,
      action: e.action,
      entityType: e.entityType,
      entityId: e.ids[0] ?? null,
      meta: { ids: e.ids, role: store.ctx.role },
    })),
  });
}
