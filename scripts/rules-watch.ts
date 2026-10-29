/** Checks every watched payor document for every org. Run daily (demo-start schedules it). */
import { watchAllOrgs } from "../src/lib/services/rules-watch";

watchAllOrgs()
  .then((results) => {
    const checks = results.flatMap((r) => r.checks);
    const by = (h: string) => checks.filter((c) => c.health === h).length;
    console.log(
      `[rules-watch] ${results.length} org(s), ${checks.length} document check(s): ${by("ok")} ok, ${by("changed")} changed since cited, ${by("broken")} broken`,
    );
    for (const c of checks.filter((x) => x.health === "broken"))
      console.log(`[rules-watch] broken: ${c.key} (${c.error})`);
    for (const c of checks.filter((x) => x.newVersion)) console.log(`[rules-watch] new version: ${c.key}`);
    process.exit(0);
  })
  .catch((e) => {
    console.error("[rules-watch] failed:", e instanceof Error ? e.message.split("\n")[0] : e);
    process.exit(1);
  });
