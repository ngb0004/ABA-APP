import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { authenticator } from "otplib";
import { db } from "../db";
import type { AuthProvider } from "./provider";

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

// A fixed hash so unknown emails take the same time as wrong passwords.
const DUMMY_HASH = hashPassword("dummy-password-for-timing");

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
    await db().user.update({ where: { id: userId }, data: { totpSecret: secret } });
    return { secret, otpauthUrl: authenticator.keyuri(user.email, "ABA Plan Assistant", secret) };
  }

  async confirmTotpEnrollment(userId: string, code: string) {
    const user = await db().user.findUniqueOrThrow({ where: { id: userId } });
    if (!user.totpSecret || !authenticator.check(code, user.totpSecret)) return false;
    await db().user.update({ where: { id: userId }, data: { mfaEnabled: true } });
    return true;
  }

  async verifyTotp(userId: string, code: string) {
    const user = await db().user.findUnique({ where: { id: userId } });
    if (!user?.totpSecret || !user.mfaEnabled) return false;
    return authenticator.check(code.trim(), user.totpSecret);
  }
}

let provider: AuthProvider | undefined;
export function authProvider(): AuthProvider {
  provider ??= new LocalAuthProvider();
  return provider;
}
