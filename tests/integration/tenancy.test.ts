import { describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";
import { db, withOrg } from "@/lib/db";
import { clientDetail } from "@/lib/services/clients";
import { dataset } from "../helpers/synthetic-eval";

const [orgA, orgB] = dataset.orgs as [(typeof dataset.orgs)[0], (typeof dataset.orgs)[0]];
const ctxA = { orgId: orgA.id, userId: orgA.users[0]!.id, role: "BCBA" as const };
const ctxB = { orgId: orgB.id, userId: orgB.users[0]!.id, role: "BCBA" as const };

describe("RLS isolation", () => {
  it("org A cannot read org B's rows, even with a raw query", async () => {
    const rows = await withOrg(
      ctxA,
      (tx) => tx.$queryRaw<{ id: string; org_id: string }[]>`SELECT id, org_id::text FROM client`,
    );
    expect(rows.length).toBe(3);
    expect(rows.every((r) => r.org_id === orgA.id)).toBe(true);
    const direct = await withOrg(ctxA, (tx) =>
      tx.$queryRawUnsafe<unknown[]>(`SELECT * FROM client WHERE org_id = '${orgB.id}'`),
    );
    expect(direct).toEqual([]);
    const bRows = await withOrg(ctxB, (tx) => tx.client.findMany());
    expect(bRows.map((c) => c.lastName)).toEqual(["Otherorg"]);
  });

  it("returns nothing at all when no org is set", async () => {
    expect(await db().client.findMany()).toEqual([]);
    expect(await db().$queryRaw<unknown[]>`SELECT * FROM goal_data_point`).toEqual([]);
  });

  it("rejects writes into another org", async () => {
    const someBClient = orgB.clients[0]!.id;
    await expect(
      withOrg(ctxA, (tx) =>
        tx.attachment.create({
          data: { orgId: orgB.id, clientId: someBClient, kind: "other", title: "cross-tenant" },
        }),
      ),
    ).rejects.toThrow(/row-level security/i);
    const updated = await withOrg(ctxA, (tx) =>
      tx.client.updateMany({ where: { id: someBClient }, data: { preferredName: "hijack" } }),
    );
    expect(updated.count).toBe(0);
  });

  it("the app role cannot bypass RLS or disable it", async () => {
    const r = await db().$queryRaw<
      { rolbypassrls: boolean; rolsuper: boolean }[]
    >`SELECT rolbypassrls, rolsuper FROM pg_roles WHERE rolname = current_user`;
    expect(r[0]).toEqual({ rolbypassrls: false, rolsuper: false });
    await expect(
      withOrg(ctxA, (tx) => tx.$executeRawUnsafe("ALTER TABLE client DISABLE ROW LEVEL SECURITY")),
    ).rejects.toThrow();
  });

  it("enforces is_synthetic = true at the database", async () => {
    await expect(
      withOrg(ctxA, (tx) =>
        tx.client.create({
          data: {
            orgId: orgA.id,
            isSynthetic: false,
            firstName: "Not",
            lastName: "Allowed",
            dob: new Date("2020-01-01"),
          },
        }),
      ),
    ).rejects.toThrow(/client_is_synthetic_only/);
  });
});

describe("audit log", () => {
  it("writes audit rows for a client read", async () => {
    const clientId = orgA.clients[1]!.id;
    const before = new Date();
    await clientDetail(ctxA, clientId, dataset.asOf);
    const rows = await withOrg(ctxA, (tx) =>
      tx.auditEvent.findMany({
        where: { createdAt: { gte: before }, action: { startsWith: "read:" }, entityType: "Client" },
      }),
    );
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.some((r) => r.entityId === clientId && r.userId === ctxA.userId)).toBe(true);
    // No PHI in audit meta: IDs only.
    expect(JSON.stringify(rows.map((r) => r.meta))).not.toMatch(/Bravo|Testchild|SYN-CIG/);
  });

  it("is append-only: UPDATE and DELETE are rejected, even for the table owner", async () => {
    await expect(
      withOrg(ctxA, (tx) => tx.$executeRawUnsafe(`UPDATE audit_event SET action = 'x'`)),
    ).rejects.toThrow();
    await expect(withOrg(ctxA, (tx) => tx.$executeRawUnsafe(`DELETE FROM audit_event`))).rejects.toThrow();
    const owner = new PrismaClient({ datasourceUrl: process.env.DIRECT_DATABASE_URL });
    try {
      await expect(owner.$executeRawUnsafe(`UPDATE audit_event SET action = 'x'`)).rejects.toThrow(
        /append-only/,
      );
      await expect(owner.$executeRawUnsafe(`DELETE FROM audit_event`)).rejects.toThrow(/append-only/);
      await expect(owner.$executeRawUnsafe(`TRUNCATE audit_event`)).rejects.toThrow(/append-only/);
    } finally {
      await owner.$disconnect();
    }
  });

  it("audit rows are isolated by org too", async () => {
    const rows = await withOrg(ctxB, (tx) => tx.auditEvent.findMany());
    expect(rows.every((r) => r.orgId === orgB.id)).toBe(true);
  });
});
