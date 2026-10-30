import { afterAll, describe, expect, it } from "vitest";
import { Prisma, PrismaClient } from "@prisma/client";
import { authenticator } from "otplib";
import { isPlatformCurator, setPlatformCurator } from "@/lib/auth/curator";
import {
  ctxFromRequest,
  getSessionByToken,
  loginWithPassword,
  SESSION_COOKIE,
  verifyMfa,
} from "@/lib/auth/session";
import { db, withOrg } from "@/lib/db";
import { listOpenReports, reportRuleProblem, resolveRuleReport } from "@/lib/services/rule-reports";
import { DEMO_PASSWORD } from "../../seed/synthetic/dataset";
import { ctxAs, curatorCtx, curatorUser, org, userOf } from "../helpers/ctx";
import { dataset } from "../helpers/synthetic-eval";

const bcba = ctxAs("BCBA");
const other = dataset.orgs[1]!;
const otherBcba = { orgId: other.id, userId: other.users[0]!.id, role: "BCBA" as const };
const owner = new PrismaClient({ datasourceUrl: process.env.DIRECT_DATABASE_URL });
afterAll(() => owner.$disconnect());

const ruleOf = (ctx: typeof bcba, payorKey: string) =>
  withOrg(ctx, async (tx) => {
    const p = await tx.payor.findUniqueOrThrow({ where: { orgId_key: { orgId: ctx.orgId, key: payorKey } } });
    return tx.payorRule.findFirstOrThrow({ where: { payorId: p.id }, orderBy: { ordinal: "asc" } });
  });

async function signIn(email: string, secret: string) {
  const step1 = await loginWithPassword(email, DEMO_PASSWORD);
  await verifyMfa(step1!.token, authenticator.generate(secret));
  return step1!.token;
}

describe("platform curator flag", () => {
  it("the seeded curator is a BCBA of the sample practice with the flag; the session exposes it", async () => {
    expect(curatorUser).toMatchObject({
      email: "curator@yoma-staff.test",
      role: "BCBA",
      platformCurator: true,
    });
    expect(await isPlatformCurator(curatorCtx)).toBe(true);
    expect(await isPlatformCurator(bcba)).toBe(false);
    const token = await signIn(curatorUser.email, curatorUser.totpSecret);
    expect(await getSessionByToken(token)).toMatchObject({ orgId: org.id, isPlatformCurator: true });
    const req = new Request("http://x/api", { headers: { cookie: `${SESSION_COOKIE}=${token}` } });
    expect(await ctxFromRequest(req)).toMatchObject({ userId: curatorUser.id, isPlatformCurator: true });
  });

  it("the app's database role cannot grant or remove the flag, even for itself", async () => {
    await expect(
      db().user.update({ where: { id: bcba.userId }, data: { isPlatformCurator: true } }),
    ).rejects.toThrow();
    await expect(
      db().user.update({ where: { id: curatorUser.id }, data: { isPlatformCurator: false } }),
    ).rejects.toThrow();
    await expect(
      db().user.create({
        data: {
          email: "sneaky@sample-practice.test",
          name: "Sneaky",
          passwordHash: "x",
          isPlatformCurator: true,
        },
      }),
    ).rejects.toThrow();
    // Ordinary account changes still work for the app role.
    await db().user.update({ where: { id: bcba.userId }, data: { failedMfaCount: 0 } });
    expect(await isPlatformCurator(bcba)).toBe(false);
  });

  it("set-curator grants and revokes through the owner connection, and audit-logs each run", async () => {
    const email = userOf("AUTH_COORDINATOR").email;
    // Platform audit rows are org-less, which RLS hides from every reader: capture them as they are
    // written, inside the same transaction as the change.
    const written: Record<string, unknown>[] = [];
    const recording = {
      $transaction: ((fn: (tx: unknown) => Promise<unknown>) =>
        owner.$transaction((tx) =>
          fn({
            user: tx.user,
            auditEvent: {
              createMany: (args: Prisma.AuditEventCreateManyArgs) => {
                written.push(args.data as Record<string, unknown>);
                return tx.auditEvent.createMany(args);
              },
            },
          }),
        )) as PrismaClient["$transaction"],
    };
    expect(await setPlatformCurator(recording, email.toUpperCase(), true, "test")).toMatchObject({
      email,
      isPlatformCurator: true,
      changed: true,
    });
    expect(await isPlatformCurator(ctxAs("AUTH_COORDINATOR"))).toBe(true);
    expect(await setPlatformCurator(recording, email, true, "test")).toMatchObject({ changed: false });
    expect(await setPlatformCurator(recording, email, false, "test")).toMatchObject({
      isPlatformCurator: false,
      changed: true,
    });
    expect(await isPlatformCurator(ctxAs("AUTH_COORDINATOR"))).toBe(false);
    expect(written.map((w) => w.action)).toEqual(["curator:grant", "curator:grant", "curator:revoke"]);
    expect(written[2]).toMatchObject({
      entityType: "User",
      entityId: userOf("AUTH_COORDINATOR").id,
      orgId: null,
      userId: null,
      meta: { changed: true, actor: "test" },
    });
    // The audit row names the account by id only.
    expect(JSON.stringify(written)).not.toContain("@");
    await expect(setPlatformCurator(owner, "nobody@sample-practice.test", true)).rejects.toMatchObject({
      status: 404,
    });
    await expect(setPlatformCurator(owner, "not an email", true)).rejects.toThrow();
  });
});

describe("rule problem reports", () => {
  it("anyone who reads rules can report; the note is length-limited and checked for client information", async () => {
    const rule = await ruleOf(bcba, "ga_medicaid");
    await expect(reportRuleProblem(ctxAs("RBT"), rule.id, { reason: "outdated" })).rejects.toMatchObject({
      status: 403,
    });
    await expect(reportRuleProblem(bcba, rule.id, { reason: "nonsense" })).rejects.toThrow();
    await expect(
      reportRuleProblem(bcba, rule.id, { reason: "other", note: "x".repeat(1001) }),
    ).rejects.toThrow(/1000/);
    await expect(
      reportRuleProblem(bcba, rule.id, {
        reason: "doesnt_match_letter",
        note: "Denial for client Alpha Testchild, member ID SYN-0001",
      }),
    ).rejects.toMatchObject({ status: 422 });
    // The rejected note is never stored, and the audit row holds no note text.
    const stored = await withOrg(bcba, (tx) =>
      tx.ruleReport.findMany({ where: { note: { contains: "Testchild" } } }),
    );
    expect(stored).toEqual([]);
    const rejected = await withOrg(bcba, (tx) =>
      tx.auditEvent.findFirstOrThrow({
        where: { action: "rule_report:rejected" },
        orderBy: { createdAt: "desc" },
      }),
    );
    expect(JSON.stringify(rejected.meta)).not.toMatch(/Testchild|SYN-/);

    const note = "Our authorization letter says the reassessment is due every 6 months, not 12.";
    const r = await reportRuleProblem(ctxAs("AUTH_COORDINATOR"), rule.id, {
      reason: "doesnt_match_letter",
      note,
    });
    const row = await withOrg(bcba, (tx) => tx.ruleReport.findUniqueOrThrow({ where: { id: r.id } }));
    expect(row).toMatchObject({
      orgId: org.id,
      lineageKey: rule.lineageKey,
      ruleId: rule.id,
      reason: "doesnt_match_letter",
      note,
      createdById: userOf("AUTH_COORDINATOR").id,
      resolvedAt: null,
    });
    const created = await withOrg(bcba, (tx) =>
      tx.auditEvent.findFirstOrThrow({ where: { action: "rule_report:create", entityId: r.id } }),
    );
    expect(JSON.stringify(created.meta)).not.toContain("reassessment");
  });

  it("only a curator lists and resolves open reports", async () => {
    const rule = await ruleOf(bcba, "ga_medicaid");
    const r = await reportRuleProblem(bcba, rule.id, { reason: "outdated", note: "" });
    await expect(listOpenReports(bcba)).rejects.toMatchObject({ status: 403 });
    await expect(resolveRuleReport(bcba, r.id, { resolution: "fixed" })).rejects.toMatchObject({
      status: 403,
    });
    const open = await listOpenReports(curatorCtx);
    expect(open.find((x) => x.id === r.id)).toMatchObject({ reason: "outdated", ruleId: rule.id });
    expect(open.find((x) => x.id === r.id)!.payorName).toBeTruthy();
    await resolveRuleReport(curatorCtx, r.id, { resolution: "Rule corrected in the library" });
    expect((await listOpenReports(curatorCtx)).some((x) => x.id === r.id)).toBe(false);
    await expect(resolveRuleReport(curatorCtx, r.id, { resolution: "again" })).rejects.toMatchObject({
      status: 404,
    });
  });

  it("reports are isolated by org (RLS), even with a raw query", async () => {
    const mine = await reportRuleProblem(bcba, (await ruleOf(bcba, "ga_medicaid")).id, { reason: "other" });
    const theirs = await reportRuleProblem(otherBcba, (await ruleOf(otherBcba, "ga_medicaid")).id, {
      reason: "wrong_for_state_plan",
    });
    const seenByA = await withOrg(
      bcba,
      (tx) => tx.$queryRaw<{ id: string; org_id: string }[]>`SELECT id, org_id::text FROM rule_report`,
    );
    expect(seenByA.map((r) => r.id)).toContain(mine.id);
    expect(seenByA.map((r) => r.id)).not.toContain(theirs.id);
    expect(seenByA.every((r) => r.org_id === org.id)).toBe(true);
    const seenByB = await withOrg(otherBcba, (tx) => tx.ruleReport.findMany());
    expect(seenByB.map((r) => r.id)).toEqual([theirs.id]);
    // No org set: nothing at all.
    expect(await db().ruleReport.findMany()).toEqual([]);
    // A curator in org A cannot resolve org B's report, and cannot write into org B.
    await expect(resolveRuleReport(curatorCtx, theirs.id, { resolution: "x" })).rejects.toMatchObject({
      status: 404,
    });
    await expect(
      withOrg(bcba, (tx) =>
        tx.ruleReport.create({
          data: { orgId: other.id, lineageKey: "x", reason: "other", createdById: bcba.userId },
        }),
      ),
    ).rejects.toThrow();
    // Reports are resolved, never deleted.
    await expect(
      withOrg(bcba, (tx) => tx.$executeRawUnsafe(`DELETE FROM rule_report WHERE id = '${mine.id}'`)),
    ).rejects.toThrow();
  });
});
