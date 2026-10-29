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

/** Step 2: TOTP. On success, binds the session to the user's org and role. */
export async function verifyMfa(token: string, code: string): Promise<SessionInfo | null> {
  const s = await getSessionByToken(token, { allowUnverified: true });
  if (!s) return null;
  const ok = await authProvider().verifyTotp(s.userId, code);
  if (!ok) {
    await audit(null, {
      action: "auth:mfa_failed",
      entityType: "User",
      entityId: s.userId,
      orgId: null,
      userId: s.userId,
    });
    return null;
  }
  const memberships = await withUser(s.userId, (tx) =>
    tx.membership.findMany({ where: { userId: s.userId } }),
  );
  // v1.0: one org per user. Multi-org selection is a later UI.
  const m = memberships[0];
  if (!m) throw new HttpError(403, "No organization membership");
  const updated = await db().authSession.update({
    where: { id: s.id },
    data: { mfaVerified: true, orgId: m.orgId, role: m.role },
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
