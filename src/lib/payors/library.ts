/**
 * Payor library sync: makes an org's payors, documents, and rules match
 * seed/payors.yaml. Idempotent and safe to run on every boot. IDs are stable,
 * so rule evidence (keyed by lineage) and document snapshots are preserved;
 * a document's watch state (health, last checked) is never reset here.
 */
import type { Prisma } from "@prisma/client";
import type { Tx } from "../db";
import { sid } from "../stable-id";
import { loadPayorSeed, resolvePayorRules } from "./load";
import type { Locator, PayorSeed } from "./types";

const day = (d: string) => new Date(`${d}T00:00:00Z`);

export function locatorFor(doc: PayorSeed["documents"][string]): Locator | null {
  if (doc.locator) return doc.locator;
  return doc.url ? { kind: "direct", url: doc.url } : null;
}

export async function syncPayorLibrary(tx: Tx, orgId: string, seed: PayorSeed = loadPayorSeed()) {
  const docIds: Record<string, string> = {};
  for (const [key, doc] of Object.entries(seed.documents)) {
    const id = sid(`${orgId}:doc:${key}`);
    docIds[key] = id;
    const data = {
      name: doc.name,
      version: doc.version,
      url: doc.url,
      effectiveDate: doc.effective_date ? day(doc.effective_date) : null,
      locator: (locatorFor(doc) ?? undefined) as Prisma.InputJsonValue | undefined,
      secondary: doc.secondary ?? false,
    };
    await tx.payorDocument.upsert({
      where: { orgId_key: { orgId, key } },
      create: { id, orgId, key, ...data },
      update: data,
    });
  }

  const payorIds: Record<string, string> = {};
  for (const p of seed.payors) {
    const id = sid(`${orgId}:payor:${p.id}`);
    payorIds[p.id] = id;
    await tx.payor.upsert({
      where: { orgId_key: { orgId, key: p.id } },
      create: { id, orgId, key: p.id, name: p.name, inherits: p.inherits ?? null },
      update: { name: p.name, inherits: p.inherits ?? null },
    });
  }

  const keep: string[] = [];
  for (const p of seed.payors) {
    const rules = resolvePayorRules(seed, p.id);
    for (const [i, r] of rules.entries()) {
      const id = sid(`${orgId}:rule:${p.id}:${i}`);
      keep.push(id);
      const data = {
        payorId: payorIds[p.id]!,
        type: r.type,
        params: r.params as Prisma.InputJsonValue,
        sourceDocumentId: r.source.key ? (docIds[r.source.key] ?? null) : null,
        sourceSection: r.source.section,
        notes: r.notes,
        inheritedFrom: r.inheritedFrom,
        lineageKey: r.lineageKey ?? r.id,
        ordinal: i,
      };
      await tx.payorRule.upsert({ where: { id }, create: { id, orgId, ...data }, update: data });
    }
  }
  const removed = await tx.payorRule.deleteMany({ where: { orgId, id: { notIn: keep } } });
  return { payorIds, docIds, rules: keep.length, removed: removed.count };
}
