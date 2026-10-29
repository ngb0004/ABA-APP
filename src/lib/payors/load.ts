import { readFileSync } from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { SeedSchema, type PayorSeed, type Rule } from "./types";

export function loadPayorSeed(file = path.join(process.cwd(), "seed/payors.yaml")): PayorSeed {
  // YAML anchors/aliases (&tricare_common / *tricare_common) are resolved by the parser.
  const doc = YAML.parse(readFileSync(file, "utf8"), { merge: true, maxAliasCount: 1000 });
  return SeedSchema.parse(doc);
}

/** Resolve a payor's full rule list: inherited parent rules first, then its own, then extra_rules. */
export function resolvePayorRules(seed: PayorSeed, payorKey: string, seen = new Set<string>()): Rule[] {
  const p = seed.payors.find((x) => x.id === payorKey);
  if (!p) throw new Error(`Unknown payor ${payorKey}`);
  if (seen.has(payorKey)) throw new Error(`Inheritance cycle at ${payorKey}`);
  seen.add(payorKey);
  const inherited = p.inherits
    ? resolvePayorRules(seed, p.inherits, seen).map((r) => ({
        ...r,
        payorKey,
        inheritedFrom: r.inheritedFrom ?? p.inherits!,
      }))
    : [];
  const own = [...p.rules, ...p.extra_rules].map((r, i): Rule => {
    const doc = r.source ? seed.documents[r.source] : undefined;
    return {
      id: `${payorKey}#${i}`,
      payorKey,
      lineageKey: `${payorKey}#${i}`,
      type: r.type,
      params: r.params,
      verified: r.verified,
      source: {
        key: r.source ?? null,
        name: doc?.name ?? null,
        version: doc?.version ?? null,
        section: r.section ?? null,
        url: doc?.url ?? null,
      },
      notes: r.notes ?? null,
      inheritedFrom: null,
    };
  });
  // Inherited copies keep the parent's lineage key, so one verification covers them all.
  return [...inherited.map((r, i) => ({ ...r, id: `${payorKey}#inh${i}` })), ...own];
}
