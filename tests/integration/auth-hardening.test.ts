import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { authenticator } from "otplib";

// Route handlers read the session cookie through next/headers; outside Next.js the test supplies it.
const jar = vi.hoisted(() => ({ token: undefined as string | undefined, headers: new Headers() }));
// Org-less auth audit rows are hidden by RLS from every reader: record them as they are written.
const audited = vi.hoisted(
  () =>
    [] as {
      action: string;
      entityId?: string | null;
      orgId?: string | null;
      userId?: string | null;
      meta?: unknown;
    }[],
);
vi.mock("@/lib/audit", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/audit")>();
  return {
    ...real,
    audit: async (...args: Parameters<typeof real.audit>) => {
      audited.push(args[1]);
      return real.audit(...args);
    },
  };
});
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => (jar.token ? { value: jar.token } : undefined) }),
  headers: async () => jar.headers,
}));

import { authProvider, totpStepOf } from "@/lib/auth/local";
import { InMemoryTokenBucket, setAuthRateLimiter } from "@/lib/auth/rate-limit";
import {
  confirmMfaEnrollment,
  ctxFromRequest,
  getSessionByToken,
  LAST_SEEN_WRITE_INTERVAL_MS,
  loginWithPassword,
  resolveSession,
  SESSION_COOKIE,
  SIGN_IN_FAILED_MESSAGE,
  startMfaEnrollment,
  verifyMfa,
} from "@/lib/auth/session";
import { db, withOrg } from "@/lib/db";
import { POST as loginRoute } from "@/app/api/auth/login/route";
import { POST as mfaRoute } from "@/app/api/auth/mfa/route";
import { POST as keepAliveRoute } from "@/app/api/auth/keepalive/route";
import { GET as sessionRoute } from "@/app/api/auth/session/route";
import { sampleOrg } from "../helpers/synthetic-eval";

const PASSWORD = "hardening-test-password";
const SECRET = authenticator.generateSecret();
const T0 = new Date("2026-11-07T15:00:05Z").getTime();
const STEP = 30_000;

/** A fresh RBT account in the sample practice, with a known authenticator secret. */
async function freshUser(email: string) {
  const existing = await db().user.findUnique({ where: { email } });
  if (existing) {
    await db().authSession.deleteMany({ where: { userId: existing.id } });
    await withOrg({ orgId: sampleOrg.id, userId: null, role: null }, (tx) =>
      tx.membership.deleteMany({ where: { userId: existing.id } }),
    );
    await db().user.delete({ where: { id: existing.id } });
  }
  const { userId } = await authProvider().createUser({
    email,
    name: "Hardening Test",
    password: PASSWORD,
    totpSecret: SECRET,
  });
  await withOrg({ orgId: sampleOrg.id, userId: null, role: null }, (tx) =>
    tx.membership.create({ data: { orgId: sampleOrg.id, userId, role: "RBT" } }),
  );
  return userId;
}

const codeAt = (ms: number) => authenticator.clone({ epoch: ms }).generate(SECRET);
const wrongAt = (ms: number) => (codeAt(ms) === "123456" ? "654321" : "123456");

/** Audit events written since `since` (an index into the recording). */
const auditRows = (action: string, since: number) => audited.slice(since).filter((e) => e.action === action);
const mark = () => audited.length;

async function signIn(email: string, at: number) {
  vi.setSystemTime(at);
  const s = await loginWithPassword(email, PASSWORD);
  const v = await verifyMfa(s!.token, codeAt(at));
  expect(v).not.toBeNull();
  return s!.token;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(T0);
});
afterEach(() => {
  vi.useRealTimers();
  for (const k of [
    "AUTH_MAX_FAILED_ATTEMPTS",
    "AUTH_LOCKOUT_MINUTES",
    "SESSION_IDLE_MINUTES",
    "SESSION_HOURS",
    "TRUSTED_PROXY_COUNT",
  ])
    delete process.env[k];
  setAuthRateLimiter(undefined);
  jar.token = undefined;
  jar.headers = new Headers();
});

describe("TOTP replay protection", () => {
  it("accepts a code once; the same time step is refused afterwards, a later step is accepted", async () => {
    const email = "replay@sample-practice.test";
    const userId = await freshUser(email);
    const since = mark();
    await signIn(email, T0);
    expect((await db().user.findUniqueOrThrow({ where: { id: userId } })).lastTotpStep).toBe(
      Math.floor(T0 / STEP),
    );
    // Ten seconds later the same code is still inside its window, but already used.
    vi.setSystemTime(T0 + 10_000);
    const again = await loginWithPassword(email, PASSWORD);
    expect(await verifyMfa(again!.token, codeAt(T0))).toBeNull();
    const failed = auditRows("auth:login_failed", since);
    expect(failed.at(-1)!.meta).toMatchObject({ reason: "code_replayed" });
    // A code for the next step (allowed for clock drift) signs in...
    expect(await verifyMfa(again!.token, codeAt(T0 + STEP))).not.toBeNull();
    // ...after which the older step's code is refused even though it is still inside the window.
    vi.setSystemTime(T0 + STEP + 5_000);
    const third = await loginWithPassword(email, PASSWORD);
    expect(await verifyMfa(third!.token, codeAt(T0))).toBeNull();
    expect(await verifyMfa(third!.token, codeAt(T0 + STEP))).toBeNull();
    vi.setSystemTime(T0 + 2 * STEP);
    expect(await verifyMfa(third!.token, codeAt(T0 + 2 * STEP))).not.toBeNull();
  });

  it("two requests racing with one code: only one signs in", async () => {
    const email = "replay-race@sample-practice.test";
    await freshUser(email);
    const a = await loginWithPassword(email, PASSWORD);
    const b = await loginWithPassword(email, PASSWORD);
    const code = codeAt(T0);
    const results = await Promise.all([verifyMfa(a!.token, code), verifyMfa(b!.token, code)]);
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it("the code that confirmed authenticator setup cannot be replayed to sign in", async () => {
    const email = "replay-enroll@sample-practice.test";
    const userId = await freshUser(email);
    await db().user.update({ where: { id: userId }, data: { totpSecret: null, mfaEnabled: false } });
    const first = await loginWithPassword(email, PASSWORD);
    const en = await startMfaEnrollment(first!.token);
    const code = authenticator.clone({ epoch: T0 }).generate(en!.secret);
    expect(await confirmMfaEnrollment(first!.token, code)).not.toBeNull();
    vi.setSystemTime(T0 + 5_000);
    const second = await loginWithPassword(email, PASSWORD);
    expect(await verifyMfa(second!.token, code)).toBeNull();
    expect(totpStepOf(code, en!.secret, T0 + 5_000)).toBe(Math.floor(T0 / STEP));
  });
});

describe("account lockout", () => {
  it("locks after five consecutive failures (passwords and codes alike) for fifteen minutes", async () => {
    const email = "lockout@sample-practice.test";
    const userId = await freshUser(email);
    const since = mark();
    for (let i = 0; i < 3; i++) expect(await loginWithPassword(email, "wrong-password")).toBeNull();
    const s = await loginWithPassword(email, PASSWORD);
    expect(await verifyMfa(s!.token, wrongAt(T0))).toBeNull();
    let u = await db().user.findUniqueOrThrow({ where: { id: userId } });
    expect(u.failedLoginCount).toBe(4);
    expect(u.lockedUntil).toBeNull();
    // Fifth failure: locked, and the pending sign-in ends.
    expect(await verifyMfa(s!.token, wrongAt(T0))).toBeNull();
    u = await db().user.findUniqueOrThrow({ where: { id: userId } });
    expect(u.lockedUntil!.getTime()).toBe(T0 + 15 * 60_000);
    expect(await getSessionByToken(s!.token, { allowUnverified: true })).toBeNull();
    const lockouts = auditRows("auth:lockout", since);
    expect(lockouts).toHaveLength(1);
    expect(lockouts[0]).toMatchObject({ entityId: userId, orgId: null });
    expect(JSON.stringify(lockouts[0]!.meta)).not.toContain(email);
    // While locked even the right password is refused.
    vi.setSystemTime(T0 + 14 * 60_000);
    expect(await loginWithPassword(email, PASSWORD)).toBeNull();
    // After fifteen minutes it works again.
    vi.setSystemTime(T0 + 15 * 60_000 + 1_000);
    await signIn(email, T0 + 15 * 60_000 + 1_000);
  });

  it("a successful sign-in resets the counter", async () => {
    const email = "lockout-reset@sample-practice.test";
    const userId = await freshUser(email);
    for (let i = 0; i < 4; i++) await loginWithPassword(email, "wrong-password");
    await signIn(email, T0);
    expect((await db().user.findUniqueOrThrow({ where: { id: userId } })).failedLoginCount).toBe(0);
    for (let i = 0; i < 4; i++) await loginWithPassword(email, "wrong-password");
    vi.setSystemTime(T0 + STEP);
    await signIn(email, T0 + STEP);
  });

  it("a lockout does not end a session that is already signed in", async () => {
    const email = "lockout-keep@sample-practice.test";
    await freshUser(email);
    const token = await signIn(email, T0);
    for (let i = 0; i < 5; i++) await loginWithPassword(email, "wrong-password");
    expect(await getSessionByToken(token)).not.toBeNull();
  });

  it("limits come from the environment", async () => {
    process.env.AUTH_MAX_FAILED_ATTEMPTS = "2";
    process.env.AUTH_LOCKOUT_MINUTES = "1";
    const email = "lockout-env@sample-practice.test";
    const userId = await freshUser(email);
    for (let i = 0; i < 2; i++) await loginWithPassword(email, "wrong-password");
    const u = await db().user.findUniqueOrThrow({ where: { id: userId } });
    expect(u.lockedUntil!.getTime()).toBe(T0 + 60_000);
  });

  it("answers a wrong password, an unknown email, and a locked account with the same response", async () => {
    setAuthRateLimiter(new InMemoryTokenBucket(1000, 300_000));
    const email = "lockout-msg@sample-practice.test";
    await freshUser(email);
    const post = (body: unknown) =>
      loginRoute(
        new Request("http://localhost/api/auth/login", {
          method: "POST",
          headers: { "content-type": "application/json", "x-forwarded-for": "203.0.113.9" },
          body: JSON.stringify(body),
        }),
      );
    const read = async (r: Response) => ({ status: r.status, body: await r.json() });
    const wrong = await read(await post({ email, password: "wrong-password" }));
    const unknown = await read(await post({ email: "nobody-here@sample-practice.test", password: PASSWORD }));
    for (let i = 0; i < 4; i++) await post({ email, password: "wrong-password" });
    const locked = await read(await post({ email, password: PASSWORD }));
    expect(wrong).toEqual({ status: 401, body: { error: SIGN_IN_FAILED_MESSAGE } });
    expect(unknown).toEqual(wrong);
    expect(locked).toEqual(wrong);
    // A wrong authenticator code gets the same sentence.
    await db().user.update({ where: { email }, data: { lockedUntil: null, failedLoginCount: 0 } });
    vi.setSystemTime(T0 + 60_000);
    const s = await loginWithPassword(email, PASSWORD);
    jar.token = s!.token;
    const r = await mfaRoute(
      new Request("http://localhost/api/auth/mfa", {
        method: "POST",
        headers: { "content-type": "application/json", "x-forwarded-for": "203.0.113.9" },
        body: JSON.stringify({ code: wrongAt(T0 + 60_000) }),
      }),
    );
    expect(await read(r)).toEqual({ status: 401, body: { error: SIGN_IN_FAILED_MESSAGE, restart: false } });
  });

  it("audit rows for an unknown email hold a keyed hash, never the email", async () => {
    const since = mark();
    await loginWithPassword("Someone.Unknown@sample-practice.test", "x");
    const rows = auditRows("auth:login_failed", since);
    const meta = JSON.stringify(rows.at(-1)!.meta);
    expect(meta).toMatch(/"emailHash":"[0-9a-f]{32}"/);
    expect(meta.toLowerCase()).not.toContain("someone");
  });
});

describe("sign-in rate limit per client IP", () => {
  const post = (ip: string, extraHops = "") =>
    loginRoute(
      new Request("http://localhost/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json", "x-forwarded-for": `${extraHops}${ip}` },
        body: JSON.stringify({ email: "nobody-rate@sample-practice.test", password: "x" }),
      }),
    );

  it("refuses an IP over the limit with 429, leaves other IPs alone, and audits once per burst", async () => {
    setAuthRateLimiter(new InMemoryTokenBucket(3, 300_000));
    const since = mark();
    for (let i = 0; i < 3; i++) expect((await post("198.51.100.7")).status).toBe(401);
    const limited = await post("198.51.100.7");
    expect(limited.status).toBe(429);
    expect((await limited.json()).error).toMatch(/Too many sign-in attempts/);
    expect((await post("198.51.100.7")).status).toBe(429);
    expect((await post("198.51.100.8")).status).toBe(401);
    // Spoofed hops before the trusted proxy's entry do not buy a fresh bucket.
    expect((await post("198.51.100.7", "10.9.9.9, ")).status).toBe(429);
    const rows = auditRows("auth:rate_limited", since);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ entityId: "login", orgId: null, userId: null });
    expect(JSON.stringify(rows[0]!.meta)).not.toContain("198.51.100.7");
    // The bucket refills over the window.
    vi.setSystemTime(T0 + 100_001);
    expect((await post("198.51.100.7")).status).toBe(401);
  });

  it("successful sign-ins give their token back, so one office address is not blocked by its own staff", async () => {
    setAuthRateLimiter(new InMemoryTokenBucket(2, 300_000));
    const email = "rate-office@sample-practice.test";
    await freshUser(email);
    const ok = () =>
      loginRoute(
        new Request("http://localhost/api/auth/login", {
          method: "POST",
          headers: { "content-type": "application/json", "x-forwarded-for": "192.0.2.10" },
          body: JSON.stringify({ email, password: PASSWORD }),
        }),
      );
    for (let i = 0; i < 5; i++) expect((await ok()).status).toBe(200);
    expect((await post("192.0.2.10")).status).toBe(401);
    expect((await post("192.0.2.10")).status).toBe(401);
    expect((await post("192.0.2.10")).status).toBe(429);
  });

  it("with two trusted proxies the client is the second entry from the right", async () => {
    process.env.TRUSTED_PROXY_COUNT = "2";
    setAuthRateLimiter(new InMemoryTokenBucket(1, 300_000));
    expect((await post("203.0.113.50, 10.0.0.1")).status).toBe(401);
    expect((await post("203.0.113.50, 10.0.0.2")).status).toBe(429);
    expect((await post("203.0.113.51, 10.0.0.1")).status).toBe(401);
  });
});

describe("idle timeout", () => {
  const apiReq = (token: string, method = "GET", headers: Record<string, string> = {}) =>
    new Request("http://localhost/api/x", {
      method,
      headers: { cookie: `${SESSION_COOKIE}=${token}`, ...headers },
    });
  const lastSeen = async (token: string) =>
    (await db().authSession.findFirstOrThrow({ where: { id: (await getSessionByToken(token))!.id } }))
      .lastSeenAt;

  it("signs out after thirty minutes without activity, and audits it", async () => {
    const email = "idle@sample-practice.test";
    await freshUser(email);
    const token = await signIn(email, T0);
    const since = mark();
    expect((await resolveSession(token, { now: new Date(T0 + 30 * 60_000) })).session).not.toBeNull();
    const r = await resolveSession(token, { now: new Date(T0 + 30 * 60_000 + 1) });
    expect(r).toMatchObject({ session: null, ended: "idle" });
    expect(await db().authSession.count({ where: { user: { email } } })).toBe(0);
    expect(auditRows("auth:idle_timeout", since)).toHaveLength(1);
  });

  it("API requests after the idle window get 401 with the inactivity message", async () => {
    const email = "idle-api@sample-practice.test";
    await freshUser(email);
    const token = await signIn(email, T0);
    vi.setSystemTime(T0 + 31 * 60_000);
    await expect(ctxFromRequest(apiReq(token, "POST"))).rejects.toMatchObject({
      status: 401,
      message: "You were signed out after 30 minutes of inactivity.",
    });
  });

  it("mutations count as activity; reads and background saves do not; writes at most once a minute", async () => {
    const email = "idle-activity@sample-practice.test";
    await freshUser(email);
    const token = await signIn(email, T0);
    // Within a minute of the last write: nothing written.
    vi.setSystemTime(T0 + LAST_SEEN_WRITE_INTERVAL_MS - 1);
    await ctxFromRequest(apiReq(token, "POST"));
    expect((await lastSeen(token)).getTime()).toBe(T0);
    // Reads (polling) and background saves: never activity.
    vi.setSystemTime(T0 + 20 * 60_000);
    await ctxFromRequest(apiReq(token, "GET"));
    await ctxFromRequest(apiReq(token, "PATCH", { "x-yoma-background": "1" }));
    expect((await lastSeen(token)).getTime()).toBe(T0);
    // A real mutation moves the window.
    await ctxFromRequest(apiReq(token, "POST"));
    expect((await lastSeen(token)).getTime()).toBe(T0 + 20 * 60_000);
    vi.setSystemTime(T0 + 45 * 60_000);
    expect(await ctxFromRequest(apiReq(token, "GET"))).toMatchObject({ userId: expect.any(String) });
  });

  it("the keep-alive extends the session; reading the time left does not", async () => {
    const email = "idle-keepalive@sample-practice.test";
    await freshUser(email);
    const token = await signIn(email, T0);
    jar.token = token;
    vi.setSystemTime(T0 + 28 * 60_000);
    const status = await sessionRoute();
    expect(await status.json()).toEqual({ idleRemainingSeconds: 120, idleTimeoutSeconds: 1800 });
    expect((await lastSeen(token)).getTime()).toBe(T0);
    const kept = await keepAliveRoute(new Request("http://localhost/api/auth/keepalive", { method: "POST" }));
    expect(await kept.json()).toEqual({ idleRemainingSeconds: 1800, idleTimeoutSeconds: 1800 });
    vi.setSystemTime(T0 + 50 * 60_000);
    expect((await sessionRoute()).status).toBe(200);
    vi.setSystemTime(T0 + 58 * 60_000 + 1000);
    const gone = await sessionRoute();
    expect(gone.status).toBe(401);
    expect(await gone.json()).toMatchObject({ signedOut: "idle" });
  });

  it("idle and absolute lifetimes come from the environment", async () => {
    process.env.SESSION_IDLE_MINUTES = "5";
    process.env.SESSION_HOURS = "1";
    const email = "idle-env@sample-practice.test";
    await freshUser(email);
    const token = await signIn(email, T0);
    expect((await resolveSession(token, { now: new Date(T0 + 5 * 60_000 + 1) })).ended).toBe("idle");
    const t2 = await signIn(email, T0 + STEP);
    // Kept active, but past the absolute lifetime: ended.
    for (let m = 4; m < 60; m += 4)
      await resolveSession(t2, { activity: true, now: new Date(T0 + STEP + m * 60_000) });
    expect((await resolveSession(t2, { now: new Date(T0 + STEP + 3600_000) })).ended).toBe("expired");
    process.env.SESSION_HOURS = "13";
    await expect(loginWithPassword(email, PASSWORD)).rejects.toThrow();
  });
});
