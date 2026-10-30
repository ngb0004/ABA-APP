/**
 * Grants (or with --revoke, removes) the platform curator flag for one account:
 *   pnpm curator:set <email> [--revoke]
 * Curators verify payor rules and review problem reports; it is not an org role and no app
 * screen or API can set it. Connects as the table owner (DIRECT_DATABASE_URL), because the
 * database rejects the app role changing the flag. The change is audit-logged.
 */
import { PrismaClient } from "@prisma/client";
import { userInfo } from "node:os";
import { parseSetCuratorArgs, setPlatformCurator } from "../src/lib/auth/curator";

async function main() {
  const { email, grant } = parseSetCuratorArgs(process.argv.slice(2));
  const url = process.env.DIRECT_DATABASE_URL;
  if (!url) throw new Error("DIRECT_DATABASE_URL (the owner connection) is not set");
  const owner = new PrismaClient({ datasourceUrl: url, errorFormat: "minimal" });
  try {
    let actor = "cli";
    try {
      actor = `cli:${userInfo().username}`;
    } catch {
      // No OS user name (some containers): record the CLI alone.
    }
    const r = await setPlatformCurator(owner, email, grant, actor);
    console.log(
      `[set-curator] ${r.email}: ${r.isPlatformCurator ? "is a platform curator" : "is not a platform curator"}${r.changed ? "" : " (unchanged)"}`,
    );
  } finally {
    await owner.$disconnect();
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    const msg = e instanceof Error ? e.message : String(e);
    // Prisma messages can start with blank lines; never print connection strings.
    const line = (
      /can only be changed by/.test(msg)
        ? "the database refused: DIRECT_DATABASE_URL must be the owner connection, not the app's"
        : (msg
            .split("\n")
            .map((l) => l.trim())
            .find(Boolean) ?? "unknown error")
    ).replace(/postgres(ql)?:\/\/\S+/g, "[url]");
    console.error("[set-curator] failed:", line);
    process.exit(1);
  });
