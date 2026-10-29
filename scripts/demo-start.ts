/**
 * Hosted demo entrypoint (e.g. Railway). Synthetic data only.
 *
 * Needs DATABASE_ADMIN_URL: an admin Postgres connection (superuser, or a role
 * with CREATEROLE and CREATEDB), and DEMO_PASSWORD (12+ characters). From those
 * it sets up the same two-role layout as local development:
 *   aba_owner  owns the schema and runs migrations
 *   aba_app    what the app connects as; cannot bypass row-level security
 * Role passwords and the session secret are derived from the admin password
 * unless set explicitly, so the host only needs the admin URL.
 * Seeds the fictional clients on first boot only (set RESEED=true to reset).
 */
import { execSync, spawn } from "node:child_process";
import { createHmac } from "node:crypto";
import { PrismaClient } from "@prisma/client";

function fail(msg: string): never {
  console.error(`[demo-start] ${msg}`);
  process.exit(1);
}

const adminRaw = process.env.DATABASE_ADMIN_URL;
if (!adminRaw) fail("DATABASE_ADMIN_URL is not set. Point it at the Postgres service's DATABASE_URL.");
if (!process.env.DEMO_PASSWORD || process.env.DEMO_PASSWORD.length < 12)
  fail("DEMO_PASSWORD (12+ characters) is not set.");

const admin = new URL(adminRaw);
const dbName = process.env.DEMO_DB_NAME ?? "aba";
const base = decodeURIComponent(admin.password);
if (!base) fail("DATABASE_ADMIN_URL has no password.");
const derive = (label: string) =>
  createHmac("sha256", base).update(`aba-demo:${label}`).digest("base64url").slice(0, 32);
const ownerPassword = process.env.DB_OWNER_PASSWORD ?? derive("aba_owner");
const appPassword = process.env.DB_APP_PASSWORD ?? derive("aba_app");
const sessionSecret = process.env.SESSION_SECRET ?? derive("session");

function urlFor(user: string, password: string, database: string) {
  const u = new URL(admin.toString());
  u.username = user;
  u.password = password;
  u.pathname = `/${database}`;
  return u.toString();
}
const ownerUrl = urlFor("aba_owner", ownerPassword, dbName);
const appUrl = urlFor("aba_app", appPassword, dbName);
// Passwords are base64url, so they are safe inside a quoted SQL literal.
const lit = (s: string) => `'${s.replace(/'/g, "''")}'`;
const ident = (s: string) => `"${s.replace(/"/g, '""')}"`;

async function setupRolesAndDatabase() {
  const pg = new PrismaClient({ datasourceUrl: admin.toString() });
  try {
    const [me] = await pg.$queryRaw<{ rolsuper: boolean; rolcreaterole: boolean; rolcreatedb: boolean }[]>`
      SELECT rolsuper, rolcreaterole, rolcreatedb FROM pg_roles WHERE rolname = current_user`;
    if (!me || !(me.rolsuper || (me.rolcreaterole && me.rolcreatedb)))
      fail("The admin database user needs SUPERUSER, or CREATEROLE and CREATEDB.");
    for (const [role, pw, extra] of [
      ["aba_owner", ownerPassword, ""],
      ["aba_app", appPassword, " NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE"],
    ] as const) {
      const exists = await pg.$queryRaw<unknown[]>`SELECT 1 FROM pg_roles WHERE rolname = ${role}`;
      await pg.$executeRawUnsafe(
        `${exists.length ? "ALTER" : "CREATE"} ROLE ${role} LOGIN PASSWORD ${lit(pw)}${extra}`,
      );
    }
    if (!me.rolsuper) await pg.$executeRawUnsafe("GRANT aba_owner TO CURRENT_USER");
    const db = await pg.$queryRaw<unknown[]>`SELECT 1 FROM pg_database WHERE datname = ${dbName}`;
    if (!db.length) await pg.$executeRawUnsafe(`CREATE DATABASE ${ident(dbName)} OWNER aba_owner`);
    await pg.$executeRawUnsafe(`GRANT CONNECT ON DATABASE ${ident(dbName)} TO aba_app`);
  } finally {
    await pg.$disconnect();
  }
}

/** Users are not row-level protected, so the demo BCBA's existence says whether the seed has run. */
async function alreadySeeded() {
  const pg = new PrismaClient({ datasourceUrl: appUrl });
  try {
    return (await pg.user.count({ where: { email: "bcba@sample-practice.test" } })) > 0;
  } finally {
    await pg.$disconnect();
  }
}

async function main() {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    DATABASE_URL: appUrl,
    DIRECT_DATABASE_URL: ownerUrl,
    SESSION_SECRET: sessionSecret,
    DEMO_MODE: process.env.DEMO_MODE ?? "true",
    LLM_PROVIDER: process.env.LLM_PROVIDER ?? "mock",
    NODE_ENV: "production",
  };
  delete env.DATABASE_ADMIN_URL;

  console.log("[demo-start] setting up database roles");
  await setupRolesAndDatabase();
  console.log("[demo-start] applying migrations");
  execSync("pnpm exec prisma migrate deploy", { stdio: "inherit", env: { ...env, DATABASE_URL: ownerUrl } });
  process.env.DATABASE_URL = appUrl;
  if (process.env.RESEED === "true" || !(await alreadySeeded())) {
    console.log("[demo-start] seeding fictional clients");
    execSync("pnpm exec tsx seed/synthetic/index.ts", { stdio: "inherit", env });
  }
  const port = process.env.PORT ?? "3000";
  console.log(`[demo-start] starting app on port ${port}`);
  const child = spawn("pnpm", ["exec", "next", "start", "-p", port], { stdio: "inherit", env });
  for (const sig of ["SIGTERM", "SIGINT"] as const) process.on(sig, () => child.kill(sig));
  child.on("exit", (code: number | null) => process.exit(code ?? 0));
}

main().catch((e) => fail(e instanceof Error ? e.message.split("\n")[0]! : "startup failed"));
