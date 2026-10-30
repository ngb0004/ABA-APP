/**
 * Drops and recreates the public schema, then applies migrations.
 * Safety: refuses anything other than the local synthetic-data databases.
 */
import { execSync } from "node:child_process";
import { PrismaClient } from "@prisma/client";

const url = process.env.DIRECT_DATABASE_URL;
if (!url) throw new Error("DIRECT_DATABASE_URL is not set");
const u = new URL(url);
const db = u.pathname.replace(/^\//, "");
if (
  !["localhost", "127.0.0.1"].includes(u.hostname) ||
  !/^(aba|aba_test(_[a-z0-9]+)?|aba_e2e(_[a-z0-9]+)?)$/.test(db)
) {
  throw new Error(
    `Refusing to reset ${u.hostname}/${db}: only local aba / aba_test(_suffix) / aba_e2e databases may be reset`,
  );
}

async function main() {
  const prisma = new PrismaClient({ datasourceUrl: url });
  await prisma.$executeRawUnsafe("DROP SCHEMA IF EXISTS public CASCADE");
  await prisma.$executeRawUnsafe("CREATE SCHEMA public AUTHORIZATION aba_owner");
  await prisma.$disconnect();
  execSync("pnpm exec prisma migrate deploy", {
    stdio: "inherit",
    env: { ...process.env, DATABASE_URL: url },
  });
}
main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
