import { PrismaClient } from "@prisma/client";

/**
 * Direct access to the e2e database (scripts/e2e-server.sh), for test set-up only: clearing the
 * authenticator replay marker between sign-ins, and moving a session's last activity back in time
 * instead of waiting thirty minutes. The app itself is never changed for tests.
 */
let client: PrismaClient | undefined;
export function e2eDb(): PrismaClient {
  client ??= new PrismaClient({
    datasourceUrl: `postgresql://aba_owner:aba_owner_dev@localhost:5432/${process.env.E2E_DB ?? "aba_e2e"}`,
  });
  return client;
}

/** The suite signs the same users in many times per 30-second step; the app refuses a replayed step. */
export async function clearTotpReplay(email: string) {
  await e2eDb().user.update({ where: { email }, data: { lastTotpStep: null } });
}

/** Makes every session of this user look idle for `minutes`. */
export async function ageSessions(email: string, minutes: number) {
  await e2eDb().authSession.updateMany({
    where: { user: { email } },
    data: { lastSeenAt: new Date(Date.now() - minutes * 60_000) },
  });
}
