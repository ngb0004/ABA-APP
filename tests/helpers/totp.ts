import { authenticator } from "otplib";
import { db } from "@/lib/db";

/**
 * The current authenticator code for a seeded user, after clearing the replay marker: tests sign
 * the same synthetic users in many times within one 30-second step, which the app (correctly)
 * refuses as a replay.
 */
export async function freshCode(email: string, secret: string): Promise<string> {
  await db().user.update({ where: { email: email.toLowerCase() }, data: { lastTotpStep: null } });
  return authenticator.generate(secret);
}
