/**
 * Payor library sync: makes an org's payors, documents, and rules match
 * seed/payors.yaml. Idempotent and safe to run on every boot. IDs are stable,
 * so rule evidence (keyed by lineage) and document snapshots are preserved;
 * a document's watch state (health, last checked) is never reset here.
 */
import { Prisma } from "@prisma/client";
import type { Tx } from "../db";
import { sid } from "../stable-id";
import { audit } from "../audit";
import { loadPayorSeed, resolvePayorRules, ruleFingerprint } from "./load";
import type { Locator, PayorSeed } from "./types";

const day = (d: string) => new Date(`${d}T00:00:00Z`);

export function locatorFor(doc: PayorSeed["documents"][string]): Locator | null {
  if (doc.locator) return doc.locator;
  return doc.url ? { kind: "direct", url: doc.url } : null;
}

/**
 * A rule's lineage includes its source key, so a renamed document gives its rules new lineages.
 * Evidence is append-only: copy each rule's evidence to the new lineage (same dates, so nothing
 * lasts longer than it would have), and record that it was carried over.
 */
async function carryEvidence(tx: Tx, orgId: string, seed: PayorSeed, oldKey: string, newKey: string) {
  let carried = 0;
  for (const p of seed.payors)
    for (const r of [...p.rules, ...p.extra_rules]) {
      if (r.source !== newKey) continue;
      const from = ruleFingerprint(p.id, { ...r, source: oldKey });
      const to = ruleFingerprint(p.id, r);
      if (await tx.ruleEvidence.findFirst({ where: { orgId, lineageKey: to }, select: { id: true } }))
        continue;
      const rows = await tx.ruleEvidence.findMany({
        where: { orgId, lineageKey: from },
        orderBy: { createdAt: "asc" },
      });
      if (!rows.length) continue;
      await tx.ruleEvidence.createMany({
        data: rows.map((e) => ({
          orgId: e.orgId,
          lineageKey: to,
          kind: e.kind,
          tier: e.tier,
          channel: e.channel,
          documentId: e.documentId,
          snapshotId: e.snapshotId,
          section: e.section,
          quote: e.quote,
          textSha256: e.textSha256,
          reference: e.reference,
          reviewerId: e.reviewerId,
          createdAt: e.createdAt,
          note: [e.note, `Carried over when ${oldKey} was renamed ${newKey}`].filter(Boolean).join(". "),
        })),
      });
      carried += rows.length;
    }
  if (carried)
    await audit(tx, {
      action: "payor_document:renamed",
      entityType: "PayorDocument",
      meta: { from: oldKey, to: newKey, evidenceCarried: carried },
    });
}

export async function syncPayorLibrary(tx: Tx, orgId: string, seed: PayorSeed = loadPayorSeed()) {
  const docIds: Record<string, string> = {};
  for (const [key, doc] of Object.entries(seed.documents)) {
    // A renamed document keeps its row (and so its fetched copies and the evidence that cites them).
    if (
      doc.formerly?.length &&
      !(await tx.payorDocument.findUnique({ where: { orgId_key: { orgId, key } } }))
    ) {
      const old = await tx.payorDocument.findFirst({ where: { orgId, key: { in: doc.formerly } } });
      if (old) {
        await tx.payorDocument.update({ where: { id: old.id }, data: { key } });
        await carryEvidence(tx, orgId, seed, old.key, key);
      }
    }
    const loc = locatorFor(doc);
    const data = {
      name: doc.name,
      version: doc.version,
      url: doc.url ?? null,
      effectiveDate: doc.effective_date ? day(doc.effective_date) : null,
      // A document that loses its public copy must stop being watched (and become uploadable).
      locator: loc ? (loc as Prisma.InputJsonValue) : Prisma.DbNull,
      secondary: doc.secondary ?? false,
    };
    const existing = await tx.payorDocument.findUnique({
      where: { orgId_key: { orgId, key } },
      select: { id: true },
    });
    let row: { id: string };
    if (existing)
      row = await tx.payorDocument.update({ where: { id: existing.id }, data, select: { id: true } });
    else {
      // A renamed row keeps the id derived from its old key; never collide with it.
      let id = sid(`${orgId}:doc:${key}`);
      for (let n = 2; await tx.payorDocument.findUnique({ where: { id }, select: { id: true } }); n++)
        id = sid(`${orgId}:doc:${key}:${n}`);
      row = await tx.payorDocument.create({ data: { id, orgId, key, ...data }, select: { id: true } });
    }
    docIds[key] = row.id;
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
    const seen = new Map<string, number>();
    for (const [i, r] of rules.entries()) {
      // Row ids follow the content fingerprint (plus an occurrence count for exact duplicates), not the position.
      const lineage = r.lineageKey!;
      const n = (seen.get(lineage) ?? 0) + 1;
      seen.set(lineage, n);
      const id = sid(`${orgId}:rule:${p.id}:${lineage}:${n}`);
      keep.push(id);
      const data = {
        payorId: payorIds[p.id]!,
        type: r.type,
        params: r.params as Prisma.InputJsonValue,
        sourceDocumentId: r.source.key ? (docIds[r.source.key] ?? null) : null,
        sourceSection: r.source.section,
        sourcePage: r.source.page ?? null,
        sourceQuote: r.source.quote ?? null,
        notes: r.notes,
        inheritedFrom: r.inheritedFrom,
        lineageKey: lineage,
        ordinal: i,
      };
      await tx.payorRule.upsert({ where: { id }, create: { id, orgId, ...data }, update: data });
    }
  }
  const removed = await tx.payorRule.deleteMany({ where: { orgId, id: { notIn: keep } } });
  return { payorIds, docIds, rules: keep.length, removed: removed.count };
}
