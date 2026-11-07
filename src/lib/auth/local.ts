import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { APP_NAME } from "../brand";
import { authenticator } from "otplib";
import { db } from "../db";
import type { AuthProvider, TotpResult } from "./provider";

const N = 16384;

export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, 32, { N });
  return `scrypt$${N}$${salt.toString("base64")}$${hash.toString("base64")}`;
}

export function checkPassword(password: string, stored: string): boolean {
  const [scheme, n, salt, hash] = stored.split("$");
  if (scheme !== "scrypt" || !salt || !hash) return false;
  const expected = Buffer.from(hash, "base64");
  const actual = scryptSync(password, Buffer.from(salt, "base64"), expected.length, { N: Number(n) });
  return timingSafeEqual(expected, actual);
}

authenticator.options = { window: 1 };

/** TOTP time-step length in seconds (RFC 6238 default, what authenticator apps use). */
export const TOTP_STEP_SECONDS = 30;

/**
 * The time step a code belongs to, or null when it matches no step in the window (one step either
 * side of now, for clock drift).
 */
export function totpStepOf(code: string, secret: string, now = Date.now()): number | null {
  const delta = authenticator.clone({ epoch: now }).checkDelta(code.trim(), secret);
  return delta === null ? null : Math.floor(now / 1000 / TOTP_STEP_SECONDS) + delta;
}

// A fixed hash so unknown emails take the same time as wrong passwords.
export const DUMMY_HASH = hashPassword("dummy-password-for-timing");

export class LocalAuthProvider implements AuthProvider {
  async createUser(input: { email: string; name: string; password: string; totpSecret?: string }) {
    const user = await db().user.create({
      data: {
        email: input.email.toLowerCase(),
        name: input.name,
        passwordHash: hashPassword(input.password),
        totpSecret: input.totpSecret ?? null,
        mfaEnabled: !!input.totpSecret,
      },
    });
    return { userId: user.id };
  }

  async verifyPassword(email: string, password: string) {
    const user = await db().user.findUnique({ where: { email: email.toLowerCase() } });
    if (!user) {
      checkPassword(password, DUMMY_HASH);
      return null;
    }
    return checkPassword(password, user.passwordHash)
      ? { userId: user.id, mfaEnabled: user.mfaEnabled }
      : null;
  }

  async beginTotpEnrollment(userId: string) {
    const user = await db().user.findUniqueOrThrow({ where: { id: userId } });
    if (user.mfaEnabled) throw new Error("MFA already enrolled");
    const secret = authenticator.generateSecret();
    return { secret, otpauthUrl: authenticator.keyuri(user.email, APP_NAME, secret) };
  }

  async confirmTotpEnrollment(userId: string, secret: string, code: string) {
    const step = totpStepOf(code, secret);
    if (step === null) return false;
    // Conditional update: if someone else finished enrolling first, this one fails. The step is
    // recorded so the same code cannot then be replayed at sign-in.
    const r = await db().user.updateMany({
      where: { id: userId, mfaEnabled: false, OR: [{ lastTotpStep: null }, { lastTotpStep: { lt: step } }] },
      data: { totpSecret: secret, mfaEnabled: true, lastTotpStep: step },
    });
    return r.count === 1;
  }

  async verifyTotp(userId: string, code: string): Promise<TotpResult> {
    const user = await db().user.findUnique({ where: { id: userId } });
    if (!user?.totpSecret || !user.mfaEnabled) return "invalid";
    const step = totpStepOf(code, user.totpSecret);
    if (step === null) return "invalid";
    // Accept only a step strictly later than the last one used; conditional, so two requests racing
    // with the same code cannot both pass.
    const r = await db().user.updateMany({
      where: { id: userId, OR: [{ lastTotpStep: null }, { lastTotpStep: { lt: step } }] },
      data: { lastTotpStep: step },
    });
    return r.count === 1 ? "ok" : "replayed";
  }
}

let provider: AuthProvider | undefined;
export function authProvider(): AuthProvider {
  provider ??= new LocalAuthProvider();
  return provider;
}
