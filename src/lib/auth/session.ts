import type { Role } from "@prisma/client";
import { createHmac, randomBytes } from "node:crypto";
import { z } from "zod";
import { audit } from "../audit";
import { db, withOrg, withUser, type OrgCtx } from "../db";
import { env } from "../env";
import { HttpError } from "../log";
import { authProvider, checkPassword, DUMMY_HASH } from "./local";
import { identifierHash } from "./rate-limit";

export const SESSION_COOKIE = "aba_session";

/** Session and lockout settings, read from the environment (src/lib/env.ts) with safe defaults. */
export function authConfig() {
  const e = env();
  return {
    sessionHours: e.SESSION_HOURS,
    idleMinutes: e.SESSION_IDLE_MINUTES,
    maxFailedAttempts: e.AUTH_MAX_FAILED_ATTEMPTS,
    lockoutMinutes: e.AUTH_LOCKOUT_MINUTES,
  };
}

/** lastSeenAt is written at most this often per session, so busy pages do not write on every request. */
export const LAST_SEEN_WRITE_INTERVAL_MS = 60_000;

/**
 * The one message for every refused sign-in step: wrong password, unknown email, wrong or replayed
 * code, or a locked account. It never tells a caller whether an account exists or is locked.
 */
export const SIGN_IN_FAILED_MESSAGE =
  "Email, password, or code is incorrect, or the account is temporarily locked. Try again later.";

export const idleMessage = (minutes = authConfig().idleMinutes) =>
  `You were signed out after ${minutes} minutes of inactivity.`;

function hashToken(token: string) {
  return createHmac("sha256", env().SESSION_SECRET).update(token).digest("hex");
}

export type SessionInfo = {
  id: string;
  userId: string;
  orgId: string | null;
  role: Role | null;
  mfaVerified: boolean;
  /** Platform curator flag, read from the user row on every request (never stored on the session). */
  isPlatformCurator: boolean;
};

const isLocked = (u: { lockedUntil: Date | null }, now: Date) => !!u.lockedUntil && u.lockedUntil > now;

/**
 * Sign-in events for a known account are filed under each practice the person belongs to, so the
 * practice's security officer sees failed sign-ins, lockouts and new authenticators for its own
 * staff on the audit page (164.308(a)(5)(ii)(C)). An account with no practice gets an org-less row.
 */
export async function auditAccount(
  userId: string,
  e: { action: string; meta?: Record<string, string | number | boolean | null> },
) {
  const memberships = await withUser(userId, (tx) =>
    tx.membership.findMany({ where: { userId }, select: { orgId: true, role: true } }),
  );
  const row = { action: e.action, entityType: "User", entityId: userId, userId, meta: e.meta ?? {} };
  if (!memberships.length) return audit(null, { ...row, orgId: null });
  for (const m of memberships)
    await withOrg({ orgId: m.orgId, userId, role: m.role }, (tx) => audit(tx, { ...row, orgId: m.orgId }));
}

/** Cookie settings for the session token (set at password sign-in, and again when MFA rotates it). */
export function sessionCookieOptions() {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: Math.round(authConfig().sessionHours * 3600),
  };
}

/**
 * How long the next lockout lasts: the base length, doubled for each lockout since the last
 * successful sign-in, capped at 24 hours. Someone holding the password cannot keep guessing codes
 * at the base rate forever.
 */
export function lockoutMinutesFor(baseMinutes: number, priorLockouts: number): number {
  return Math.min(baseMinutes * 2 ** Math.min(priorLockouts, 20), 24 * 60);
}

/**
 * Counts one failed attempt (wrong password, wrong or replayed code). At the limit the account
 * locks for a while, the counter restarts, and pending (not yet verified) sign-ins end.
 * Fully signed-in sessions are left alone, so an attacker cannot sign out the real person.
 */
async function recordFailedAttempt(userId: string, reason: string) {
  const { maxFailedAttempts, lockoutMinutes } = authConfig();
  await auditAccount(userId, { action: "auth:login_failed", meta: { reason } });
  const u = await db().user.update({
    where: { id: userId },
    data: { failedLoginCount: { increment: 1 } },
    select: { failedLoginCount: true, lockoutCount: true },
  });
  if (u.failedLoginCount < maxFailedAttempts) return;
  const now = new Date();
  const minutes = lockoutMinutesFor(lockoutMinutes, u.lockoutCount);
  // Conditional: two failures racing past the limit lock once and audit once.
  const locked = await db().user.updateMany({
    where: { id: userId, failedLoginCount: { gte: maxFailedAttempts } },
    data: {
      failedLoginCount: 0,
      lockoutCount: { increment: 1 },
      lockedUntil: new Date(now.getTime() + minutes * 60_000),
    },
  });
  if (!locked.count) return;
  await db().authSession.deleteMany({ where: { userId, mfaVerified: false } });
  await auditAccount(userId, {
    action: "auth:lockout",
    meta: { minutes, consecutive: u.lockoutCount + 1 },
  });
}

async function refuseLocked(userId: string, step: string) {
  await auditAccount(userId, { action: "auth:login_failed", meta: { reason: "locked", step } });
}

/** Step 1: password. Creates a session that is not usable until MFA passes. */
export async function loginWithPassword(email: string, password: string) {
  const now = new Date();
  const account = await db().user.findUnique({
    where: { email: email.toLowerCase() },
    select: { id: true, lockedUntil: true },
  });
  if (account && isLocked(account, now)) {
    // Same work as a real check, so a locked account answers in the same time as a wrong password.
    checkPassword(password, DUMMY_HASH);
    await refuseLocked(account.id, "password");
    return null;
  }
  const res = await authProvider().verifyPassword(email, password);
  if (!res) {
    if (account) await recordFailedAttempt(account.id, "password");
    else
      await audit(null, {
        action: "auth:login_failed",
        entityType: "User",
        orgId: null,
        userId: null,
        // A keyed hash only: the email itself is never written to the audit log.
        meta: { reason: "unknown_account", emailHash: identifierHash(email) },
      });
    return null;
  }
  const token = randomBytes(32).toString("base64url");
  await db().authSession.create({
    data: {
      tokenHash: hashToken(token),
      userId: res.userId,
      lastSeenAt: now,
      expiresAt: new Date(now.getTime() + authConfig().sessionHours * 3600_000),
    },
  });
  await auditAccount(res.userId, { action: "auth:password_ok" });
  return {
    token,
    mfaEnabled: res.mfaEnabled,
    mustChangePassword: res.mustChangePassword,
    userId: res.userId,
  };
}

export const CHOOSE_PASSWORD_FIRST = "Choose your own password before setting up your authenticator.";

/** A temporary (admin-set) password only lets the person choose their own: no MFA step until then. */
async function assertOwnPassword(userId: string) {
  const u = await db().user.findUniqueOrThrow({
    where: { id: userId },
    select: { mustChangePassword: true },
  });
  if (u.mustChangePassword)
    throw new HttpError(409, CHOOSE_PASSWORD_FIRST, undefined, { mustChangePassword: true });
}

export const NewPasswordSchema = z
  .string()
  .min(12, "Choose a password of at least 12 characters")
  .max(200, "That password is too long");

/**
 * First sign-in of an account an admin created: the person replaces the temporary password with
 * their own (checked again here), so the admin, or anyone who saw the temporary one, no longer
 * holds a working password. Other sign-ins of the account end. Audited as auth:password_set.
 */
export async function chooseOwnPassword(token: string, currentPassword: string, newPassword: string) {
  const s = await getSessionByToken(token, { allowUnverified: true });
  if (!s) return null;
  const next = NewPasswordSchema.parse(newPassword);
  if (await lockedNow(s.userId)) {
    await refuseLocked(s.userId, "password_set");
    return null;
  }
  const user = await db().user.findUniqueOrThrow({ where: { id: s.userId } });
  if (!user.mustChangePassword) throw new HttpError(409, "This account already has its own password");
  if (!checkPassword(currentPassword, user.passwordHash)) {
    await recordFailedAttempt(s.userId, "password_set");
    return null;
  }
  if (next === currentPassword)
    throw new HttpError(400, "Choose a password different from the temporary one");
  await authProvider().setOwnPassword(s.userId, next);
  await db().authSession.deleteMany({ where: { userId: s.userId, id: { not: s.id } } });
  await auditAccount(s.userId, { action: "auth:password_set" });
  return { mfaEnabled: user.mfaEnabled };
}

/** True when the account is locked right now (checked before every code). */
async function lockedNow(userId: string) {
  const u = await db().user.findUniqueOrThrow({ where: { id: userId }, select: { lockedUntil: true } });
  return isLocked(u, new Date());
}

/** A fully signed-in session, with the new token the MFA step issued (set it as the cookie). */
export type SignedIn = SessionInfo & { token: string };

/**
 * After a correct code: bind the session to the user's org and role, and issue a new token. The
 * token seen before MFA (a logged proxy, a shared browser profile) never becomes a full session.
 */
async function completeSignIn(s: SessionInfo): Promise<SignedIn> {
  const user = await db().user.update({
    where: { id: s.userId },
    data: { failedLoginCount: 0, lockedUntil: null, lockoutCount: 0 },
    select: { isPlatformCurator: true },
  });
  const memberships = await withUser(s.userId, (tx) =>
    tx.membership.findMany({ where: { userId: s.userId } }),
  );
  // v1.0: one org per user. Multi-org selection is a later UI.
  const m = memberships[0];
  if (!m) throw new HttpError(403, "No organization membership");
  const token = randomBytes(32).toString("base64url");
  const updated = await db().authSession.update({
    where: { id: s.id },
    data: {
      tokenHash: hashToken(token),
      mfaVerified: true,
      orgId: m.orgId,
      role: m.role,
      pendingTotpSecret: null,
      lastSeenAt: new Date(),
    },
  });
  await withOrg({ orgId: m.orgId, userId: s.userId, role: m.role }, (tx) =>
    audit(tx, { action: "auth:login", entityType: "User", entityId: s.userId, meta: { sessionId: s.id } }),
  );
  return {
    token,
    id: updated.id,
    userId: updated.userId,
    orgId: updated.orgId,
    role: updated.role,
    mfaVerified: true,
    isPlatformCurator: user.isPlatformCurator,
  };
}

/** Step 2: TOTP. On success, binds the session to the user's org and role. */
export async function verifyMfa(token: string, code: string): Promise<SignedIn | null> {
  const s = await getSessionByToken(token, { allowUnverified: true });
  if (!s) return null;
  if (await lockedNow(s.userId)) {
    await refuseLocked(s.userId, "code");
    return null;
  }
  await assertOwnPassword(s.userId);
  const result = await authProvider().verifyTotp(s.userId, code);
  if (result !== "ok") {
    await recordFailedAttempt(s.userId, result === "replayed" ? "code_replayed" : "code");
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
  await assertOwnPassword(s.userId);
  const user = await db().user.findUniqueOrThrow({ where: { id: s.userId } });
  if (user.mfaEnabled) throw new HttpError(409, "Authenticator already set up");
  const r = await authProvider().beginTotpEnrollment(s.userId);
  await db().authSession.update({ where: { id: s.id }, data: { pendingTotpSecret: r.secret } });
  await auditAccount(s.userId, { action: "auth:mfa_enroll_start" });
  return r;
}

/** Confirms enrollment with a first valid code, then completes sign-in. */
export async function confirmMfaEnrollment(token: string, code: string): Promise<SignedIn | null> {
  const s = await getSessionByToken(token, { allowUnverified: true });
  if (!s) return null;
  if (await lockedNow(s.userId)) {
    await refuseLocked(s.userId, "enroll");
    return null;
  }
  await assertOwnPassword(s.userId);
  const row = await db().authSession.findUniqueOrThrow({ where: { id: s.id } });
  if (!row.pendingTotpSecret) throw new HttpError(409, "Start authenticator setup first");
  if (!(await authProvider().confirmTotpEnrollment(s.userId, row.pendingTotpSecret, code))) {
    const u = await db().user.findUniqueOrThrow({ where: { id: s.userId } });
    if (u.mfaEnabled)
      throw new HttpError(
        409,
        "This account's authenticator was just set up from another sign-in. Sign in again and use that authenticator.",
      );
    await recordFailedAttempt(s.userId, "enroll_code");
    return null;
  }
  await auditAccount(s.userId, { action: "auth:mfa_enrolled" });
  return completeSignIn(s);
}

export type SessionLookup =
  | { session: SessionInfo; ended?: undefined; idleRemainingMs: number }
  | { session: null; ended: "none" | "expired" | "idle" | "removed"; idleRemainingMs?: undefined };

/**
 * Looks up a session and enforces both lifetimes: absolute (SESSION_HOURS) and idle
 * (SESSION_IDLE_MINUTES). A session past either is deleted. `activity: true` marks this request as
 * the person's own activity (see src/lib/auth/idle.ts for what counts) and moves lastSeenAt,
 * written at most once a minute.
 */
export async function resolveSession(
  token: string | undefined | null,
  opts: { allowUnverified?: boolean; activity?: boolean; now?: Date } = {},
): Promise<SessionLookup> {
  if (!token) return { session: null, ended: "none" };
  const now = opts.now ?? new Date();
  const row = await db().authSession.findUnique({
    where: { tokenHash: hashToken(token) },
    include: { user: { select: { isPlatformCurator: true } } },
  });
  if (!row) return { session: null, ended: "none" };
  if (row.expiresAt <= now) {
    await db().authSession.deleteMany({ where: { id: row.id } });
    return { session: null, ended: "expired" };
  }
  const idleMs = authConfig().idleMinutes * 60_000;
  const idleFor = now.getTime() - row.lastSeenAt.getTime();
  if (idleFor > idleMs) {
    const gone = await db().authSession.deleteMany({ where: { id: row.id } });
    if (gone.count && row.mfaVerified && row.orgId && row.role)
      await withOrg({ orgId: row.orgId, userId: row.userId, role: row.role }, (tx) =>
        audit(tx, { action: "auth:idle_timeout", entityType: "User", entityId: row.userId }),
      );
    return { session: null, ended: "idle" };
  }
  const { user, ...s } = row;
  if (!s.mfaVerified && !opts.allowUnverified) return { session: null, ended: "none" };
  let lastSeen = row.lastSeenAt;
  if (opts.activity && idleFor >= LAST_SEEN_WRITE_INTERVAL_MS) {
    // Conditional, so concurrent requests write once.
    await db().authSession.updateMany({
      where: { id: s.id, lastSeenAt: { lte: new Date(now.getTime() - LAST_SEEN_WRITE_INTERVAL_MS) } },
      data: { lastSeenAt: now },
    });
    lastSeen = now;
  }
  const idleRemainingMs = idleMs - (now.getTime() - lastSeen.getTime());
  // Curator rights need a fully signed-in session.
  const isPlatformCurator = s.mfaVerified && user.isPlatformCurator;
  if (s.orgId) {
    // The membership is the authority, not the copy on the session: a removed or re-roled
    // person loses access (or gets the new role) on their next request.
    const m = await withUser(s.userId, (tx) =>
      tx.membership.findFirst({ where: { userId: s.userId, orgId: s.orgId! }, select: { role: true } }),
    );
    if (!m) {
      await db().authSession.deleteMany({ where: { id: s.id } });
      return { session: null, ended: "removed" };
    }
    return {
      session: {
        id: s.id,
        userId: s.userId,
        orgId: s.orgId,
        role: m.role,
        mfaVerified: s.mfaVerified,
        isPlatformCurator,
      },
      idleRemainingMs,
    };
  }
  return {
    session: {
      id: s.id,
      userId: s.userId,
      orgId: s.orgId,
      role: s.role,
      mfaVerified: s.mfaVerified,
      isPlatformCurator,
    },
    idleRemainingMs,
  };
}

export async function getSessionByToken(
  token: string | undefined | null,
  opts: { allowUnverified?: boolean; activity?: boolean; now?: Date } = {},
): Promise<SessionInfo | null> {
  return (await resolveSession(token, opts)).session;
}

/** Ends the session and, for a signed-in one, writes auth:logout (so a sign-out is told apart from a session left open). */
export async function logout(token: string | undefined) {
  if (!token) return;
  const row = await db().authSession.findUnique({ where: { tokenHash: hashToken(token) } });
  if (!row) return;
  const gone = await db().authSession.deleteMany({ where: { id: row.id } });
  if (gone.count && row.mfaVerified && row.orgId && row.role)
    await withOrg({ orgId: row.orgId, userId: row.userId, role: row.role }, (tx) =>
      audit(tx, {
        action: "auth:logout",
        entityType: "User",
        entityId: row.userId,
        meta: { sessionId: row.id },
      }),
    );
}

export function tokenFromCookieHeader(header: string | null): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === SESSION_COOKIE) return decodeURIComponent(v.join("="));
  }
  return null;
}

/** Header the UI sets on requests it makes in the background (autosave): they never count as activity. */
export const BACKGROUND_HEADER = "x-yoma-background";

/**
 * Whether an API request counts as the person's activity for the idle timeout: mutations do,
 * unless the UI marked them as background; reads (GET/HEAD, which is what polling uses) never do.
 */
export function isActivityRequest(req: Request): boolean {
  if (req.method === "GET" || req.method === "HEAD") return false;
  return req.headers.get(BACKGROUND_HEADER) !== "1";
}

/** For route handlers: a fully authenticated session (password + MFA + org) or 401. */
export async function ctxFromRequest(req: Request): Promise<OrgCtx> {
  const r = await resolveSession(tokenFromCookieHeader(req.headers.get("cookie")), {
    activity: isActivityRequest(req),
  });
  if (r.ended === "idle") throw new HttpError(401, idleMessage(), undefined, { signedOut: "idle" });
  const s = r.session;
  if (!s || !s.orgId) throw new HttpError(401, "Not authenticated");
  return { orgId: s.orgId, userId: s.userId, role: s.role, isPlatformCurator: s.isPlatformCurator };
}
