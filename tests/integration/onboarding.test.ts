import { describe, expect, it } from "vitest";
import { authenticator } from "otplib";
import {
  CHOOSE_PASSWORD_FIRST,
  chooseOwnPassword,
  confirmMfaEnrollment,
  getSessionByToken,
  lockoutMinutesFor,
  loginWithPassword,
  startMfaEnrollment,
} from "@/lib/auth/session";
import { db, withOrg } from "@/lib/db";
import { addMember, MEMBER_EMAIL_TAKEN, removeMember } from "@/lib/services/records";
import { ctxAs, curatorUser } from "../helpers/ctx";
import { dataset } from "../helpers/synthetic-eval";

const bcba = ctxAs("BCBA");
const other = dataset.orgs[1]!;
const otherBcba = { orgId: other.id, userId: other.users[0]!.id, role: "BCBA" as const };
const TEMP = "temporary-from-the-admin";

async function fresh(email: string) {
  const u = await db().user.findUnique({ where: { email } });
  if (u) {
    for (const ctx of [bcba, otherBcba])
      await withOrg(ctx, (tx) => tx.membership.deleteMany({ where: { userId: u.id } }));
    await db().authSession.deleteMany({ where: { userId: u.id } });
    await db().user.delete({ where: { id: u.id } });
  }
}

describe("lockout backoff", () => {
  it("doubles each consecutive lockout and caps at a day", () => {
    expect([0, 1, 2, 3].map((n) => lockoutMinutesFor(15, n))).toEqual([15, 30, 60, 120]);
    expect(lockoutMinutesFor(15, 7)).toBe(24 * 60);
    expect(lockoutMinutesFor(15, 500)).toBe(24 * 60);
  });
});

describe("a new member chooses their own password before their authenticator", () => {
  it("the admin's temporary password only allows choosing a new one, then stops working", async () => {
    const email = "onboard.rbt@sample-practice.test";
    await fresh(email);
    await addMember(bcba, { email, name: "Onboard RBT", role: "RBT", password: TEMP });
    const s = await loginWithPassword(email, TEMP);
    expect(s).toMatchObject({ mustChangePassword: true, mfaEnabled: false });
    await expect(startMfaEnrollment(s!.token)).rejects.toMatchObject({
      status: 409,
      message: CHOOSE_PASSWORD_FIRST,
    });
    await expect(confirmMfaEnrollment(s!.token, "123456")).rejects.toMatchObject({ status: 409 });
    // The temporary password must be given again, and the new one must differ and be long enough.
    expect(await chooseOwnPassword(s!.token, "wrong-temporary", "my-own-password-123")).toBeNull();
    await expect(chooseOwnPassword(s!.token, TEMP, "short")).rejects.toThrow(/12 characters/);
    await expect(chooseOwnPassword(s!.token, TEMP, TEMP)).rejects.toMatchObject({ status: 400 });
    // Someone else who signed in with the temporary password loses that sign-in.
    const other = await loginWithPassword(email, TEMP);
    expect(await chooseOwnPassword(s!.token, TEMP, "my-own-password-123")).toEqual({ mfaEnabled: false });
    expect(await getSessionByToken(other!.token, { allowUnverified: true })).toBeNull();
    expect(await getSessionByToken(s!.token, { allowUnverified: true })).not.toBeNull();
    expect(await loginWithPassword(email, TEMP)).toBeNull();
    await expect(
      chooseOwnPassword(s!.token, "my-own-password-123", "another-password-456"),
    ).rejects.toMatchObject({
      status: 409,
    });
    const en = await startMfaEnrollment(s!.token);
    const done = await confirmMfaEnrollment(s!.token, authenticator.generate(en!.secret));
    expect(done).toMatchObject({ orgId: bcba.orgId, role: "RBT" });
    const rows = await withOrg(bcba, (tx) =>
      tx.auditEvent.findMany({ where: { action: "auth:password_set", entityId: s!.userId } }),
    );
    expect(rows).toHaveLength(1);
  });
});

describe("adding a member never takes over another account", () => {
  it("refuses a platform curator's email, even with no practice", async () => {
    const curatorMemberships = await withOrg(bcba, (tx) =>
      tx.membership.findMany({ where: { userId: curatorUser.id } }),
    );
    await withOrg(bcba, (tx) => tx.membership.deleteMany({ where: { userId: curatorUser.id } }));
    try {
      await expect(
        addMember(otherBcba, { email: curatorUser.email, name: "x", role: "BCBA", password: TEMP }),
      ).rejects.toMatchObject({ status: 409, message: MEMBER_EMAIL_TAKEN });
      await expect(
        addMember(bcba, { email: curatorUser.email, name: "x", role: "BCBA", password: TEMP }),
      ).rejects.toMatchObject({ status: 409 });
    } finally {
      await withOrg(bcba, (tx) =>
        tx.membership.createMany({
          data: curatorMemberships.map((m) => ({ id: m.id, orgId: m.orgId, userId: m.userId, role: m.role })),
        }),
      );
    }
  });

  it("refuses an account another practice removed, with the same answer as any taken email", async () => {
    const email = "left.practice@sample-practice.test";
    await fresh(email);
    const m = await addMember(bcba, { email, name: "Leaver", role: "RBT", password: TEMP });
    await removeMember(bcba, m.id);
    await expect(
      addMember(otherBcba, { email, name: "x", role: "RBT", password: TEMP }),
    ).rejects.toMatchObject({
      status: 409,
      message: MEMBER_EMAIL_TAKEN,
    });
    // The practice that removed them can add them back.
    const again = await addMember(bcba, { email, name: "Leaver", role: "RBT", password: TEMP });
    await removeMember(bcba, again.id);
  });
});
