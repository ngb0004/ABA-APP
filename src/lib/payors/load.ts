import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { SeedSchema, type PayorSeed, type Rule } from "./types";

export function loadPayorSeed(file = path.join(process.cwd(), "seed/payors.yaml")): PayorSeed {
  // YAML anchors/aliases (&tricare_common / *tricare_common) are resolved by the parser.
  const doc = YAML.parse(readFileSync(file, "utf8"), { merge: true, maxAliasCount: 1000 });
  return SeedSchema.parse(doc);
}

/** JSON with sorted keys, so equal content always hashes the same. */
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v && typeof v === "object")
    return `{${Object.keys(v as object)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`)
      .join(",")}}`;
  return JSON.stringify(v);
}

/**
 * A rule's lineage key is a fingerprint of what it says (type, params, source,
 * section) within the payor that defines it. Reordering the YAML cannot move
 * evidence to another rule, and editing a rule detaches its old evidence. Scope fields
 * (plan_types, the payor's states) are left out on purpose: narrowing who a rule applies to
 * does not change what the source says, so it keeps its evidence.
 */
export function ruleFingerprint(
  payorKey: string,
  r: { type: string; params: unknown; source?: string | null; section?: string | null },
) {
  const h = createHash("sha256")
    .update(
      canonical({ type: r.type, params: r.params, source: r.source ?? null, section: r.section ?? null }),
    )
    .digest("hex");
  return `${payorKey}:${h.slice(0, 20)}`;
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
      lineageKey: ruleFingerprint(payorKey, r),
      type: r.type,
      params: r.params,
      verified: r.verified,
      source: {
        key: r.source ?? null,
        name: doc?.name ?? null,
        version: doc?.version ?? null,
        section: r.section ?? null,
        url: doc?.url ?? null,
        page: r.page !== undefined ? String(r.page) : null,
        quote: r.quote ?? null,
      },
      notes: r.notes ?? null,
      inheritedFrom: null,
      planTypes: r.plan_types ?? [],
    };
  });
  // Inherited copies keep the parent's lineage key, so one verification covers them all.
  return [...inherited.map((r, i) => ({ ...r, id: `${payorKey}#inh${i}` })), ...own];
}
