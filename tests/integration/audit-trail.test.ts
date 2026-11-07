import { describe, expect, it, vi } from "vitest";

const jar = vi.hoisted(() => ({ token: undefined as string | undefined }));
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => (jar.token ? { value: jar.token } : undefined) }),
  headers: async () => new Headers(),
}));

import { draftWithFirewall, MockProvider } from "@/lib/ai";
import { loginWithPassword, SESSION_COOKIE, verifyMfa } from "@/lib/auth/session";
import { withOrg, type OrgCtx } from "@/lib/db";
import { SourcedContext } from "@/lib/firewall";
import { requirePermission } from "@/lib/permissions";
import { api } from "@/lib/server/api";
import { POST as logoutRoute } from "@/app/api/auth/logout/route";
import { ctxAs, clientId, org, userOf } from "../helpers/ctx";
import { dataset } from "../helpers/synthetic-eval";
import { freshCode } from "../helpers/totp";

const other = dataset.orgs[1]!;
const otherBcba: OrgCtx = { orgId: other.id, userId: other.users[0]!.id, role: "BCBA" };

const rowsSince = (ctx: OrgCtx, since: Date, action: string) =>
  withOrg(ctx, (tx) =>
    tx.auditEvent.findMany({ where: { action, createdAt: { gte: since } }, orderBy: { createdAt: "asc" } }),
  );

async function signIn(role: "RBT" | "BCBA") {
  const u = userOf(role);
  const s = await loginWithPassword(u.email, u.password);
  const v = await verifyMfa(s!.token, await freshCode(u.email, u.totpSecret));
  return v!.token;
}

describe("refused requests leave an audit row", () => {
  it("a role-forbidden API call writes exactly one access:denied row, attributed to the caller", async () => {
    const token = await signIn("RBT");
    const since = new Date(Date.now() - 1000);
    const handler = api<{ id: string }>(async (_req, ctx) => {
      requirePermission(ctx.role, "org:manage");
      return { reached: true };
    });
    const target = "00000000-0000-4000-8000-000000000001";
    const res = await handler(
      new Request(`http://x/api/settings/members/${target}`, {
        method: "DELETE",
        headers: { cookie: `${SESSION_COOKIE}=${token}` },
      }),
      { params: Promise.resolve({ id: target }) },
    );
    expect(res.status).toBe(403);
    const rows = await rowsSince(ctxAs("BCBA"), since, "access:denied");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ userId: userOf("RBT").id, orgId: org.id, entityId: target });
    expect(rows[0]!.meta).toMatchObject({
      status: 403,
      method: "DELETE",
      route: "/api/settings/members/:id",
      permission: "org:manage",
      role: "RBT",
    });
  });

  it("a probe for another practice's client id is recorded, with the id asked for", async () => {
    const since = new Date(Date.now() - 1000);
    const probed = clientId("client1");
    await expect(
      withOrg(otherBcba, (tx) => tx.client.findUniqueOrThrow({ where: { id: probed } })),
    ).rejects.toThrow();
    const rows = await rowsSince(otherBcba, since, "read:findUniqueOrThrow");
    expect(rows.some((r) => (r.meta as { ids: string[] }).ids.includes(probed))).toBe(true);
    expect(rows.at(-1)!.meta).toMatchObject({ rolledBack: true, count: 0 });
  });

  it("reads made before a refused step survive the rollback", async () => {
    const since = new Date(Date.now() - 1000);
    const bcba = ctxAs("BCBA");
    const id = clientId("client2");
    await expect(
      withOrg(bcba, async (tx) => {
        await tx.client.findUnique({ where: { id } });
        throw new Error("refused after reading");
      }),
    ).rejects.toThrow("refused after reading");
    const rows = await rowsSince(bcba, since, "read:findUnique");
    expect(
      rows.some(
        (r) =>
          r.entityType === "Client" && r.entityId === id && (r.meta as { rolledBack?: boolean }).rolledBack,
      ),
    ).toBe(true);
  });

  it("a read of many rows records the full count and every id", async () => {
    const since = new Date(Date.now() - 1000);
    const bcba = ctxAs("BCBA");
    const n = await withOrg(bcba, async (tx) => (await tx.client.findMany({ select: { id: true } })).length);
    const rows = await rowsSince(bcba, since, "read:findMany");
    const r = rows.filter((x) => x.entityType === "Client").at(-1)!;
    expect((r.meta as { count: number }).count).toBe(n);
    expect((r.meta as { ids: string[] }).ids).toHaveLength(n);
  });
});

describe("sign-in activity is visible to the practice", () => {
  it("a failed password for a member is on the practice's audit trail, not org-less", async () => {
    const since = new Date(Date.now() - 1000);
    expect(await loginWithPassword(userOf("RBT").email, "wrong-password")).toBeNull();
    const rows = await rowsSince(ctxAs("BCBA"), since, "auth:login_failed");
    expect(rows.at(-1)).toMatchObject({ entityId: userOf("RBT").id, orgId: org.id });
    // Another practice cannot see it.
    expect(await rowsSince(otherBcba, since, "auth:login_failed")).toHaveLength(0);
    // Clear the failure so later sign-ins start from zero.
    await signIn("RBT");
  });

  it("signing out writes auth:logout and refuses a cross-origin request", async () => {
    const token = await signIn("BCBA");
    jar.token = token;
    const since = new Date(Date.now() - 1000);
    const cross = await logoutRoute(
      new Request("http://x/api/auth/logout", {
        method: "POST",
        headers: { origin: "http://evil.test", host: "x" },
      }),
    );
    expect(cross.status).toBe(403);
    const res = await logoutRoute(
      new Request("http://x/api/auth/logout", { method: "POST", headers: { host: "x" } }),
    );
    expect(res.status).toBe(200);
    jar.token = undefined;
    const rows = await rowsSince(ctxAs("BCBA"), since, "auth:logout");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ userId: userOf("BCBA").id });
  });
});

describe("AI privacy guard trips", () => {
  it("are audited with the failed check, never the value", async () => {
    const bcba = ctxAs("BCBA");
    const since = new Date(Date.now() - 1000);
    const entityId = clientId("client1");
    await expect(
      draftWithFirewall(null, {
        ctx: bcba,
        system: "Write a sentence.",
        payload: { text: "Zoë likes trains" },
        sourced: new SourcedContext([]),
        identifiers: { names: ["Zoë"], memberIds: [] },
        audit: { entityType: "Client", entityId, task: "test", clientId: entityId },
        provider: new MockProvider(),
      }),
    ).rejects.toMatchObject({ name: "AiPrivacyError", check: "name" });
    const rows = await rowsSince(bcba, since, "ai:privacy_blocked");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.meta).toMatchObject({ check: "name", task: "test", clientId: entityId });
    expect(JSON.stringify(rows[0])).not.toContain("Zoë");
    expect(await rowsSince(bcba, since, "ai:call")).toHaveLength(0);
  });
});
