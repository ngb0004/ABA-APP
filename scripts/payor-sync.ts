/** Syncs every org's payors, documents, and rules with seed/payors.yaml. Safe to run on every boot. */
import { db, withOrg } from "../src/lib/db";
import { syncPayorLibrary } from "../src/lib/payors/library";

async function main() {
  const orgs = await db().$queryRaw<{ id: string }[]>`SELECT app_org_ids() AS id`;
  let rules = 0;
  let removed = 0;
  for (const { id } of orgs) {
    const r = await withOrg({ orgId: id, userId: null, role: null }, (tx) => syncPayorLibrary(tx, id));
    rules += r.rules;
    removed += r.removed;
  }
  console.log(
    `[payor-sync] ${orgs.length} org(s): ${rules} rules in the library${removed ? `, ${removed} retired` : ""}`,
  );
  if (!orgs.length)
    console.log("[payor-sync] no orgs visible: the owner role may lack BYPASSRLS (app_org_ids)");
}
main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("[payor-sync] failed:", e instanceof Error ? e.message.split("\n")[0] : e);
    process.exit(1);
  });
