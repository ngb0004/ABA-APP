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

type PendingAudit = { action: string; entityType: string; ids: string[]; count: number };
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

/** Ids kept per audit row; a larger read also records its full row count, and the extra ids go to more rows. */
export const AUDIT_IDS_PER_ROW = 200;

/** Rows affected: a list's length, or `{count}` from createMany/updateMany/deleteMany. */
function rowCount(result: unknown): number {
  if (result && typeof result === "object" && typeof (result as { count?: unknown }).count === "number")
    return (result as { count: number }).count;
  return result ? 1 : 0;
}

function collectIds(args: unknown, result: unknown): string[] {
  const ids: string[] = [];
  const push = (v: unknown) => {
    if (typeof v === "string") ids.push(v);
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
          const store = als.getStore();
          const record = (result: unknown) => {
            if (!store || !AUDITED_MODELS.has(model)) return;
            const kind = READ_OPS.has(operation) ? "read" : "write";
            const ids = collectIds(args, result);
            store.events.push({
              action: `${kind}:${operation}`,
              entityType: model,
              ids,
              count: Array.isArray(result) ? result.length : rowCount(result),
            });
          };
          let result: unknown;
          try {
            result = await query(args);
          } catch (e) {
            // A miss (findUniqueOrThrow on another org's id) is still an access attempt: record the id asked for.
            record(undefined);
            throw e;
          }
          record(result);
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

/**
 * Run fn with RLS scoped to ctx.orgId. Audit rows for data access are written in the same
 * transaction. If fn fails, the transaction rolls back, so the reads and attempted writes it made
 * are written again in a transaction of their own (marked rolledBack): a refused or failed request
 * still leaves its trail.
 */
export async function withOrg<T>(ctx: OrgCtx, fn: (tx: Tx) => Promise<T>): Promise<T> {
  const store: Store = { ctx, events: [] };
  try {
    return await db().$transaction(
      async (tx) => {
        await setScope(tx as Tx, ctx);
        // Awaited inside the store's context: Prisma queries are lazy and run when awaited, so a bare
        // `tx.model.findUnique(...)` returned by fn would otherwise run outside it, unaudited.
        const result = await als.run(store, async () => await fn(tx as Tx));
        await flushAudit(tx as Tx, store, false);
        return result;
      },
      { timeout: 60_000, maxWait: 15_000 },
    );
  } catch (e) {
    if (store.events.length)
      await db()
        .$transaction(async (tx) => {
          await setScope(tx as Tx, ctx);
          await flushAudit(tx as Tx, store, true);
        })
        .catch(() => undefined);
    throw e;
  }
}

async function setScope(tx: Tx, ctx: OrgCtx) {
  await tx.$queryRaw`SELECT set_config('app.current_org', ${ctx.orgId}, true), set_config('app.current_user', ${ctx.userId ?? ""}, true)`;
}

/** Identity-only scope (no org yet), used at login to list a user's memberships. */
export async function withUser<T>(userId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return db().$transaction(async (tx) => {
    await tx.$queryRaw`SELECT set_config('app.current_user', ${userId}, true)`;
    return fn(tx as Tx);
  });
}

/**
 * Records a read that Prisma's audit hook cannot see (a raw SQL query on a client-data table):
 * same row shape as an automatic read, under `entityType`, naming the record ids it concerned.
 */
export function noteRawRead(entityType: string, ids: string[], count: number) {
  als.getStore()?.events.push({ action: "read:raw", entityType, ids, count });
}

export function currentCtx(): OrgCtx | undefined {
  return als.getStore()?.ctx;
}

async function flushAudit(tx: Tx, store: Store, rolledBack: boolean) {
  if (!store.events.length) return;
  // Collapse repeated operations on the same model into one row per transaction (more rows when
  // there are more ids than fit in one), with the total row count.
  const grouped = new Map<string, PendingAudit>();
  for (const e of store.events) {
    const key = `${e.action}|${e.entityType}`;
    const prev = grouped.get(key);
    if (prev) {
      prev.ids = [...new Set([...prev.ids, ...e.ids])];
      prev.count += e.count;
    } else grouped.set(key, { ...e, ids: [...new Set(e.ids)] });
  }
  const data = [...grouped.values()].flatMap((e) => {
    const chunks: string[][] = [];
    for (let i = 0; i < e.ids.length; i += AUDIT_IDS_PER_ROW)
      chunks.push(e.ids.slice(i, i + AUDIT_IDS_PER_ROW));
    if (!chunks.length) chunks.push([]);
    return chunks.map((ids, part) => ({
      orgId: store.ctx.orgId,
      userId: store.ctx.userId,
      action: e.action,
      entityType: e.entityType,
      entityId: ids[0] ?? null,
      meta: {
        ids,
        role: store.ctx.role,
        count: e.count,
        ...(chunks.length > 1 ? { part: part + 1, parts: chunks.length } : {}),
        ...(rolledBack ? { rolledBack: true } : {}),
      },
    }));
  });
  await tx.auditEvent.createMany({ data });
}
