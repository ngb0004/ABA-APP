import type { Role } from "@prisma/client";
import { createHmac, randomBytes } from "node:crypto";
import { audit } from "../audit";
import { db, withOrg, withUser, type OrgCtx } from "../db";
import { env } from "../env";
import { HttpError } from "../log";
import { authProvider } from "./local";

export const SESSION_COOKIE = "aba_session";
const SESSION_HOURS = 12;

function hashToken(token: string) {
  return createHmac("sha256", env().SESSION_SECRET).update(token).digest("hex");
}

export type SessionInfo = {
  id: string;
  userId: string;
  orgId: string | null;
  role: Role | null;
  mfaVerified: boolean;
};

/** Step 1: password. Creates a session that is not usable until MFA passes. */
export async function loginWithPassword(email: string, password: string) {
  const res = await authProvider().verifyPassword(email, password);
  if (!res) {
    await audit(null, { action: "auth:login_failed", entityType: "User", orgId: null, userId: null });
    return null;
  }
  const token = randomBytes(32).toString("base64url");
  await db().authSession.create({
    data: {
      tokenHash: hashToken(token),
      userId: res.userId,
      expiresAt: new Date(Date.now() + SESSION_HOURS * 3600_000),
    },
  });
  await audit(null, {
    action: "auth:password_ok",
    entityType: "User",
    entityId: res.userId,
    orgId: null,
    userId: res.userId,
  });
  return { token, mfaEnabled: res.mfaEnabled, userId: res.userId };
}

/** Wrong codes allowed per sign-in before the password must be entered again. */
export const MAX_MFA_ATTEMPTS_PER_SESSION = 5;
/** Consecutive wrong codes across sign-ins before the account's MFA locks for a while. */
export const MAX_MFA_FAILURES_PER_USER = 10;
export const MFA_LOCK_MINUTES = 15;

export class MfaLockedError extends HttpError {
  constructor() {
    super(429, `Too many incorrect codes. Try again in ${MFA_LOCK_MINUTES} minutes.`);
  }
}

async function assertNotLocked(userId: string) {
  const u = await db().user.findUniqueOrThrow({ where: { id: userId } });
  if (u.mfaLockedUntil && u.mfaLockedUntil > new Date()) throw new MfaLockedError();
}

/** Counts a wrong code. Ends the sign-in after too many, and locks the user after more. */
async function recordMfaFailure(s: SessionInfo, action: string) {
  await audit(null, { action, entityType: "User", entityId: s.userId, orgId: null, userId: s.userId });
  const session = await db().authSession.update({
    where: { id: s.id },
    data: { failedMfaAttempts: { increment: 1 } },
  });
  if (session.failedMfaAttempts >= MAX_MFA_ATTEMPTS_PER_SESSION)
    await db().authSession.delete({ where: { id: s.id } });
  const user = await db().user.update({
    where: { id: s.userId },
    data: { failedMfaCount: { increment: 1 } },
  });
  if (user.failedMfaCount >= MAX_MFA_FAILURES_PER_USER) {
    await db().user.update({
      where: { id: s.userId },
      data: { failedMfaCount: 0, mfaLockedUntil: new Date(Date.now() + MFA_LOCK_MINUTES * 60_000) },
    });
    await audit(null, {
      action: "auth:mfa_locked",
      entityType: "User",
      entityId: s.userId,
      orgId: null,
      userId: s.userId,
    });
  }
}

/** After a correct code: bind the session to the user's org and role. */
async function completeSignIn(s: SessionInfo): Promise<SessionInfo> {
  await db().user.update({ where: { id: s.userId }, data: { failedMfaCount: 0, mfaLockedUntil: null } });
  const memberships = await withUser(s.userId, (tx) =>
    tx.membership.findMany({ where: { userId: s.userId } }),
  );
  // v1.0: one org per user. Multi-org selection is a later UI.
  const m = memberships[0];
  if (!m) throw new HttpError(403, "No organization membership");
  const updated = await db().authSession.update({
    where: { id: s.id },
    data: { mfaVerified: true, orgId: m.orgId, role: m.role, pendingTotpSecret: null, failedMfaAttempts: 0 },
  });
  await withOrg({ orgId: m.orgId, userId: s.userId, role: m.role }, (tx) =>
    audit(tx, { action: "auth:login", entityType: "User", entityId: s.userId }),
  );
  return {
    id: updated.id,
    userId: updated.userId,
    orgId: updated.orgId,
    role: updated.role,
    mfaVerified: true,
  };
}

/** Step 2: TOTP. On success, binds the session to the user's org and role. */
export async function verifyMfa(token: string, code: string): Promise<SessionInfo | null> {
  const s = await getSessionByToken(token, { allowUnverified: true });
  if (!s) return null;
  await assertNotLocked(s.userId);
  if (!(await authProvider().verifyTotp(s.userId, code))) {
    await recordMfaFailure(s, "auth:mfa_failed");
    return null;
  }
  return completeSignIn(s);
}

/**
 * First sign-in for a user without MFA: start TOTP enrollment. The pending
 * secret is kept on this sign-in session only, so two people enrolling at the
 * same time cannot overwrite each other; the first to confirm wins.
 */
export async function startMfaEnrollment(token: string) {
  const s = await getSessionByToken(token, { allowUnverified: true });
  if (!s) return null;
  const user = await db().user.findUniqueOrThrow({ where: { id: s.userId } });
  if (user.mfaEnabled) throw new HttpError(409, "Authenticator already set up");
  const r = await authProvider().beginTotpEnrollment(s.userId);
  await db().authSession.update({ where: { id: s.id }, data: { pendingTotpSecret: r.secret } });
  await audit(null, {
    action: "auth:mfa_enroll_start",
    entityType: "User",
    entityId: s.userId,
    orgId: null,
    userId: s.userId,
  });
  return r;
}

/** Confirms enrollment with a first valid code, then completes sign-in. */
export async function confirmMfaEnrollment(token: string, code: string): Promise<SessionInfo | null> {
  const s = await getSessionByToken(token, { allowUnverified: true });
  if (!s) return null;
  await assertNotLocked(s.userId);
  const row = await db().authSession.findUniqueOrThrow({ where: { id: s.id } });
  if (!row.pendingTotpSecret) throw new HttpError(409, "Start authenticator setup first");
  if (!(await authProvider().confirmTotpEnrollment(s.userId, row.pendingTotpSecret, code))) {
    const u = await db().user.findUniqueOrThrow({ where: { id: s.userId } });
    if (u.mfaEnabled)
      throw new HttpError(
        409,
        "This account's authenticator was just set up from another sign-in. Sign in again and use that authenticator.",
      );
    await recordMfaFailure(s, "auth:mfa_enroll_failed");
    return null;
  }
  await audit(null, {
    action: "auth:mfa_enrolled",
    entityType: "User",
    entityId: s.userId,
    orgId: null,
    userId: s.userId,
  });
  return completeSignIn(s);
}

export async function getSessionByToken(
  token: string | undefined | null,
  opts: { allowUnverified?: boolean } = {},
): Promise<SessionInfo | null> {
  if (!token) return null;
  const s = await db().authSession.findUnique({ where: { tokenHash: hashToken(token) } });
  if (!s || s.expiresAt < new Date()) return null;
  if (!s.mfaVerified && !opts.allowUnverified) return null;
  return { id: s.id, userId: s.userId, orgId: s.orgId, role: s.role, mfaVerified: s.mfaVerified };
}

export async function logout(token: string | undefined) {
  if (!token) return;
  await db().authSession.deleteMany({ where: { tokenHash: hashToken(token) } });
}

export function tokenFromCookieHeader(header: string | null): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === SESSION_COOKIE) return decodeURIComponent(v.join("="));
  }
  return null;
}

/** For route handlers: a fully authenticated session (password + MFA + org) or 401. */
export async function ctxFromRequest(req: Request): Promise<OrgCtx> {
  const s = await getSessionByToken(tokenFromCookieHeader(req.headers.get("cookie")));
  if (!s || !s.orgId) throw new HttpError(401, "Not authenticated");
  return { orgId: s.orgId, userId: s.userId, role: s.role };
}
