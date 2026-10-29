import { execSync } from "node:child_process";
import { config } from "./test-env";

/** Migrates and seeds the test database once per run. */
export default function setup() {
  if (process.env.SKIP_DB_SETUP) return;
  const env = { ...process.env, ...config };
  execSync("bash scripts/db-up.sh", { stdio: "ignore", env });
  execSync("pnpm exec tsx scripts/db-reset-schema.ts", { stdio: "ignore", env });
  execSync("pnpm exec tsx seed/synthetic/index.ts", { stdio: "inherit", env });
}
