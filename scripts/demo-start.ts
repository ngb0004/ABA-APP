/**
 * Hosted demo entrypoint (e.g. Railway). Fictional data only; always demo mode.
 *
 * Needs DATABASE_ADMIN_URL: an admin Postgres connection (superuser, or a role
 * with CREATEROLE and CREATEDB), and DEMO_PASSWORD (12+ characters). From those
 * it sets up the same two-role layout as local development:
 *   aba_owner  owns the schema and runs migrations
 *   aba_app    what the app connects as; cannot bypass row-level security
 * Role passwords and the session secret are derived from the admin password
 * unless set explicitly, so the host only needs the admin URL.
 *
 * Every boot: migrate; seed if the seed has not completed (or RESEED=true);
 * re-apply demo credentials (so a changed DEMO_PASSWORD takes effect; RESET_MFA
 * clears authenticators); freeze the app's "today" at the seed date so the
 * fictional scenarios stay current; start the app with only the app role's URL.
 */
import { execSync, spawn } from "node:child_process";
import { createHmac } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { checkPassword, hashPassword } from "../src/lib/auth/local";
import { buildDataset, SEED_VERSION } from "../seed/synthetic/dataset";

function fail(msg: string): never {
  console.error(`[demo-start] ${msg}`);
  process.exit(1);
}
const say = (msg: string) => console.log(`[demo-start] ${msg}`);

if (process.env.DEMO_MODE !== undefined && process.env.DEMO_MODE !== "true")
  fail("This entrypoint only runs the demo. Remove DEMO_MODE or set it to true.");
const demoPassword = process.env.DEMO_PASSWORD ?? "";
if (demoPassword.length < 12) fail("DEMO_PASSWORD (12+ characters) is not set.");
if (!process.env.DATABASE_ADMIN_URL)
  fail("DATABASE_ADMIN_URL is not set. Point it at the Postgres service's DATABASE_URL.");

let admin: URL;
try {
  admin = new URL(process.env.DATABASE_ADMIN_URL);
} catch {
  fail("DATABASE_ADMIN_URL is not a valid connection URL."); // never echo it: it contains a password
}
const base = (() => {
  try {
    return decodeURIComponent(admin.password);
  } catch {
    return admin.password;
  }
})();
if (!base) fail("DATABASE_ADMIN_URL has no password.");
const dbName = process.env.DEMO_DB_NAME ?? "aba";
const derive = (label: string) =>
  createHmac("sha256", base).update(`aba-demo:${label}`).digest("base64url").slice(0, 32);
const ownerPassword = process.env.DB_OWNER_PASSWORD ?? derive("aba_owner");
const appPassword = process.env.DB_APP_PASSWORD ?? derive("aba_app");
// Ignore short or placeholder secrets (e.g. the value copied from .env.example).
const givenSecret = process.env.SESSION_SECRET ?? "";
const weakSecret = givenSecret.length < 32 || /change-me|not-for-production/i.test(givenSecret);
if (givenSecret && weakSecret) say("ignoring weak SESSION_SECRET; using a derived one");
const sessionSecret = weakSecret ? derive("session") : givenSecret;

function urlFor(user: string, password: string, database: string) {
  const u = new URL(admin.toString());
  u.username = user;
  u.password = password;
  u.pathname = `/${database}`;
  return u.toString();
}
const ownerUrl = urlFor("aba_owner", ownerPassword, dbName);
const appUrl = urlFor("aba_app", appPassword, dbName);
const lit = (s: string) => `'${s.replace(/'/g, "''")}'`;
const ident = (s: string) => `"${s.replace(/"/g, '""')}"`;

const dataset = buildDataset("2000-01-01");
const demoUsers = dataset.orgs.flatMap((o) => o.users);
const sampleOrgId = dataset.orgs[0]!.id;
const lastOrgId = dataset.orgs.at(-1)!.id;

async function setupRolesAndDatabase() {
  const pg = new PrismaClient({ datasourceUrl: admin.toString() });
  try {
    const [me] = await pg.$queryRaw<{ rolsuper: boolean; rolcreaterole: boolean; rolcreatedb: boolean }[]>`
      SELECT rolsuper, rolcreaterole, rolcreatedb FROM pg_roles WHERE rolname = current_user`;
    if (!me || !(me.rolsuper || (me.rolcreaterole && me.rolcreatedb)))
      fail("The admin database user needs SUPERUSER, or CREATEROLE and CREATEDB.");
    for (const [role, pw] of [
      ["aba_owner", ownerPassword],
      ["aba_app", appPassword],
    ] as const) {
      const [r] = await pg.$queryRaw<{ rolsuper: boolean; rolbypassrls: boolean }[]>`
        SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = ${role}`;
      if (!r) {
        const attrs = role === "aba_app" ? " NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE" : "";
        await pg.$executeRawUnsafe(`CREATE ROLE ${role} LOGIN PASSWORD ${lit(pw)}${attrs}`);
      } else {
        if (role === "aba_app" && (r.rolsuper || r.rolbypassrls))
          fail("Role aba_app can bypass row-level security. Fix the role before starting.");
        await pg.$executeRawUnsafe(`ALTER ROLE ${role} LOGIN PASSWORD ${lit(pw)}`);
      }
    }
    if (!me.rolsuper) await pg.$executeRawUnsafe("GRANT aba_owner TO CURRENT_USER");
    // Scheduled jobs list org ids through app_org_ids(), owned by a NOLOGIN role with one narrow
    // policy. The owner stays subject to RLS (an earlier build granted it BYPASSRLS: undo that).
    const lister = await pg.$queryRaw<unknown[]>`SELECT 1 FROM pg_roles WHERE rolname = 'aba_org_lister'`;
    if (!lister.length)
      await pg.$executeRawUnsafe("CREATE ROLE aba_org_lister NOLOGIN NOSUPERUSER NOBYPASSRLS");
    await pg.$executeRawUnsafe("GRANT aba_org_lister TO aba_owner");
    if (me.rolsuper) await pg.$executeRawUnsafe("ALTER ROLE aba_owner NOBYPASSRLS");

    const db = await pg.$queryRaw<unknown[]>`SELECT 1 FROM pg_database WHERE datname = ${dbName}`;
    if (!db.length) await pg.$executeRawUnsafe(`CREATE DATABASE ${ident(dbName)} OWNER aba_owner`);
    await pg.$executeRawUnsafe(`GRANT CONNECT ON DATABASE ${ident(dbName)} TO aba_app`);
  } finally {
    await pg.$disconnect();
  }
}

/** The seed date and version an org was loaded with, read through RLS as the app role. */
async function seedInfo(orgId: string): Promise<{ asOf: string | null; version: number | null }> {
  const pg = new PrismaClient({ datasourceUrl: appUrl });
  try {
    return await pg.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT set_config('app.current_org', ${orgId}, true)`;
      const org = await tx.org.findUnique({ where: { id: orgId } });
      const s = (org?.settings ?? {}) as { seededAsOf?: string; seedVersion?: number };
      return { asOf: s.seededAsOf ?? null, version: s.seedVersion ?? null };
    });
  } finally {
    await pg.$disconnect();
  }
}

/** seededAsOf for an org, read through RLS as the app role (null if that org was never fully seeded). */
async function seededAsOf(orgId: string): Promise<string | null> {
  const pg = new PrismaClient({ datasourceUrl: appUrl });
  try {
    return await pg.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT set_config('app.current_org', ${orgId}, true)`;
      const org = await tx.org.findUnique({ where: { id: orgId } });
      return (
        ((org?.settings as { seededAsOf?: string } | undefined)?.seededAsOf as string | undefined) ?? null
      );
    });
  } finally {
    await pg.$disconnect();
  }
}

/** Re-apply demo credentials without touching clinical data. */
async function syncDemoCredentials() {
  const pg = new PrismaClient({ datasourceUrl: appUrl });
  const publicSecrets = new Set(demoUsers.map((u) => u.totpSecret));
  const resetMfa = (process.env.RESET_MFA ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  try {
    let changed = 0;
    for (const u of demoUsers) {
      const row = await pg.user.findUnique({ where: { email: u.email } });
      if (!row) continue;
      const data: {
        passwordHash?: string;
        totpSecret?: null;
        mfaEnabled?: boolean;
        failedMfaCount?: number;
        mfaLockedUntil?: null;
      } = {};
      if (!checkPassword(demoPassword, row.passwordHash)) data.passwordHash = hashPassword(demoPassword);
      // A public secret from the repo (seeded outside demo mode) must never stay active on the hosted demo.
      const publicSecret = row.totpSecret !== null && publicSecrets.has(row.totpSecret);
      if (publicSecret || resetMfa.includes("all") || resetMfa.includes(u.email))
        Object.assign(data, { totpSecret: null, mfaEnabled: false, failedMfaCount: 0, mfaLockedUntil: null });
      if (!Object.keys(data).length) continue;
      await pg.user.update({ where: { id: row.id }, data });
      await pg.authSession.deleteMany({ where: { userId: row.id } });
      changed++;
    }
    if (changed) say(`updated demo sign-in settings for ${changed} account(s)`);
    if (resetMfa.length) say("RESET_MFA applied; remove the variable so it does not run on every restart");
  } finally {
    await pg.$disconnect();
  }
}

async function main() {
  const shared: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    NODE_ENV: "production",
    DEMO_MODE: "true",
    LLM_PROVIDER: process.env.LLM_PROVIDER ?? "mock",
    LLM_MODEL: process.env.LLM_MODEL,
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
    PLAYWRIGHT_BROWSERS_PATH: process.env.PLAYWRIGHT_BROWSERS_PATH,
    NEXT_TELEMETRY_DISABLED: "1",
  };

  say("setting up database roles");
  await setupRolesAndDatabase();
  say("applying migrations");
  execSync("pnpm exec prisma migrate deploy", {
    stdio: "inherit",
    env: { ...shared, DATABASE_URL: ownerUrl, DIRECT_DATABASE_URL: ownerUrl },
  });

  const seeded = await seedInfo(lastOrgId);
  const outdated = !!seeded.asOf && seeded.version !== SEED_VERSION;
  if (process.env.RESEED === "true" || !seeded.asOf || outdated) {
    say(
      process.env.RESEED === "true"
        ? "RESEED=true: reloading fictional clients (remove the variable afterwards)"
        : outdated
          ? `demo data is from seed version ${seeded.version ?? 1}; reloading fictional clients for version ${SEED_VERSION}`
          : "seeding fictional clients",
    );
    execSync("pnpm exec tsx seed/synthetic/index.ts", {
      stdio: "inherit",
      env: { ...shared, DATABASE_URL: appUrl, DIRECT_DATABASE_URL: ownerUrl, DEMO_PASSWORD: demoPassword },
    });
  } else {
    await syncDemoCredentials();
  }
  // Payor rules are data: bring every org's library in line with seed/payors.yaml (evidence is kept).
  execSync("REQUIRE_ORGS=1 pnpm exec tsx scripts/payor-sync.ts", {
    stdio: "inherit",
    env: { ...shared, DATABASE_URL: appUrl, DIRECT_DATABASE_URL: appUrl },
  });
  // The fictional scenarios are dated relative to the seed day; keep "today" there.
  const asOf = process.env.APP_AS_OF ?? (await seededAsOf(sampleOrgId));
  if (asOf) say(`demo date is ${asOf}`);

  const port = process.env.PORT ?? "3000";
  say(`starting app on port ${port}`);
  // The web server gets only the app role's URL: no admin or owner credentials, no demo password.
  const appEnv: NodeJS.ProcessEnv = {
    ...shared,
    DATABASE_URL: appUrl,
    DIRECT_DATABASE_URL: appUrl,
    SESSION_SECRET: sessionSecret,
    ...(asOf ? { APP_AS_OF: asOf } : {}),
  };
  const child = spawn("pnpm", ["exec", "next", "start", "-p", port], { stdio: "inherit", env: appEnv });
  for (const sig of ["SIGTERM", "SIGINT"] as const) process.on(sig, () => child.kill(sig));
  child.on("exit", (code: number | null) => process.exit(code ?? 0));

  // Check payor sources shortly after start, then daily. A failed run is logged and retried next time.
  // One check at a time: a slow run is never overlapped by the next one.
  let watching = false;
  const watch = () => {
    if (watching) return say("previous source check still running; skipping this one");
    watching = true;
    const w = spawn("pnpm", ["exec", "tsx", "scripts/rules-watch.ts"], { stdio: "inherit", env: appEnv });
    w.on("exit", (code: number | null) => {
      watching = false;
      if (code) say(`source check exited with code ${code}`);
    });
  };
  setTimeout(watch, 30_000).unref();
  setInterval(watch, 24 * 3600_000).unref();
}

main().catch((e) =>
  fail(
    e instanceof Error
      ? (e.message.split("\n")[0] ?? "startup failed").replace(/postgres(ql)?:\/\/\S+/g, "[url]")
      : "startup failed",
  ),
);
