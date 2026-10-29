/**
 * Rules Watch services: check payor sources, and verify or revoke rules with evidence.
 */
import { Prisma } from "@prisma/client";
import { audit, sha256 } from "../audit";
import { db, withOrg, type OrgCtx } from "../db";
import { toDay } from "../dates";
import { HttpError } from "../log";
import { requirePermission } from "../permissions";
import { LocatorSchema, type Locator } from "../payors/types";
import {
  defaultFetch,
  fetchCurrentDocument,
  type FetchedDocument,
  type FetchLike,
} from "../rules-watch/fetch";
import { numbersMissingFromQuote, quoteAppears } from "../rules-watch/text";

export type SourceCheck = {
  key: string;
  name: string;
  health: string;
  newVersion: boolean;
  error: string | null;
};

/**
 * Fetch every watched document for one org and record what changed. Network
 * calls happen outside database transactions. `cache` lets a run across many
 * orgs fetch each public document once.
 */
export async function watchOrgSources(
  ctx: OrgCtx,
  opts: { fetcher?: FetchLike; cache?: Map<string, Promise<FetchedDocument>>; now?: Date } = {},
): Promise<SourceCheck[]> {
  const fetcher = opts.fetcher ?? defaultFetch;
  const cache = opts.cache ?? new Map();
  const now = opts.now ?? new Date();
  const docs = await withOrg(ctx, (tx) =>
    tx.payorDocument.findMany({ where: { locator: { not: Prisma.DbNull } }, orderBy: { key: "asc" } }),
  );
  const out: SourceCheck[] = [];
  for (const doc of docs) {
    const parsed = LocatorSchema.safeParse(doc.locator);
    if (!parsed.success) continue;
    const locator: Locator = parsed.data;
    const cacheKey = JSON.stringify(locator);
    if (!cache.has(cacheKey)) cache.set(cacheKey, fetchCurrentDocument(locator, fetcher));
    const r = await cache.get(cacheKey)!;
    out.push(
      await withOrg(ctx, async (tx) => {
        if (!r.ok) {
          await tx.payorDocument.update({
            where: { id: doc.id },
            data: { health: "broken", lastError: r.error, lastCheckedAt: now },
          });
          if (doc.health !== "broken")
            await audit(tx, {
              action: "source:broken",
              entityType: "PayorDocument",
              entityId: doc.id,
              meta: { key: doc.key, error: r.error },
            });
          return { key: doc.key, name: doc.name, health: "broken", newVersion: false, error: r.error };
        }
        const latest = await tx.payorDocumentSnapshot.findFirst({
          where: { documentId: doc.id },
          orderBy: { fetchedAt: "desc" },
          select: { textSha256: true, versionLabel: true },
        });
        const first = await tx.payorDocumentSnapshot.findFirst({
          where: { documentId: doc.id },
          orderBy: { fetchedAt: "asc" },
          select: { textSha256: true },
        });
        // Where the payor publishes a version label, only a new label is a new version (page chrome changes are ignored).
        const isNew =
          !latest ||
          (r.versionLabel ? r.versionLabel !== latest.versionLabel : r.textSha256 !== latest.textSha256);
        if (isNew) {
          await tx.payorDocumentSnapshot.create({
            data: {
              orgId: ctx.orgId,
              documentId: doc.id,
              fetchedAt: now,
              resolvedUrl: r.resolvedUrl,
              contentType: r.contentType.slice(0, 120),
              byteLength: r.byteLength,
              textSha256: r.textSha256,
              text: r.text,
              versionLabel: r.versionLabel,
              effectiveDate: r.effectiveDate ? new Date(`${r.effectiveDate}T00:00:00Z`) : null,
              nextRevision: r.nextRevision ? new Date(`${r.nextRevision}T00:00:00Z`) : null,
              revisions: r.revisions as unknown as Prisma.InputJsonValue,
            },
          });
        }
        const cited = doc.effectiveDate ? toDay(doc.effectiveDate) : null;
        const newerThanCited = !!(r.effectiveDate && cited && r.effectiveDate > cited);
        const changedSinceFirst = !!(first && first.textSha256 !== r.textSha256 && !r.versionLabel);
        const health = newerThanCited || changedSinceFirst ? "changed" : "ok";
        await tx.payorDocument.update({
          where: { id: doc.id },
          data: {
            health,
            lastError: null,
            lastCheckedAt: now,
            ...(isNew && latest ? { lastChangedAt: now } : {}),
          },
        });
        if (isNew && latest)
          await audit(tx, {
            action: "source:changed",
            entityType: "PayorDocument",
            entityId: doc.id,
            meta: { key: doc.key, version: r.versionLabel },
          });
        return { key: doc.key, name: doc.name, health, newVersion: isNew && !!latest, error: null };
      }),
    );
  }
  return out;
}

/** Check sources now (BCBA action). */
export async function checkSourcesNow(ctx: OrgCtx, fetcher?: FetchLike) {
  requirePermission(ctx.role, "payor:verify");
  const res = await watchOrgSources(ctx, { fetcher });
  await withOrg(ctx, (tx) =>
    audit(tx, {
      action: "source:check_now",
      entityType: "Org",
      entityId: ctx.orgId,
      meta: { checked: res.length },
    }),
  );
  return res;
}

/** Scheduled run across every org. Uses the narrow app_org_ids() helper (no org data). */
export async function watchAllOrgs(fetcher?: FetchLike) {
  const orgs = await db().$queryRaw<{ id: string }[]>`SELECT app_org_ids() AS id`;
  const cache = new Map<string, Promise<FetchedDocument>>();
  const results: { orgId: string; checks: SourceCheck[] }[] = [];
  for (const { id } of orgs)
    results.push({
      orgId: id,
      checks: await watchOrgSources({ orgId: id, userId: null, role: null }, { fetcher, cache }),
    });
  return results;
}

const MIN_QUOTE = 15;

/**
 * Verify a rule with proof: the reviewer pastes a sentence from the current
 * official document. Code checks the sentence is really there and that every
 * number in the rule appears in it. The evidence covers the rule's lineage
 * (the rule and the copies other payors inherit).
 */
export async function verifyRuleWithQuote(
  ctx: OrgCtx,
  ruleId: string,
  input: { quote: string; section?: string | null; documentId?: string | null; note?: string | null },
) {
  requirePermission(ctx.role, "payor:verify");
  return withOrg(ctx, async (tx) => {
    const rule = await tx.payorRule.findUniqueOrThrow({ where: { id: ruleId } });
    const documentId = input.documentId || rule.sourceDocumentId;
    if (!documentId) throw new HttpError(422, "Choose the official document that states this rule");
    const doc = await tx.payorDocument.findUniqueOrThrow({ where: { id: documentId } });
    if (doc.secondary)
      throw new HttpError(
        422,
        `${doc.name} is a secondary source. Verify against an official payor document instead.`,
      );
    const snap = await tx.payorDocumentSnapshot.findFirst({
      where: { documentId },
      orderBy: { fetchedAt: "desc" },
    });
    if (!snap)
      throw new HttpError(409, `No copy of ${doc.name} has been fetched yet. Use "Check sources now" first.`);
    const quote = input.quote.trim();
    if (quote.length < MIN_QUOTE)
      throw new HttpError(
        422,
        `Paste the full sentence that states the rule (at least ${MIN_QUOTE} characters)`,
      );
    if (!quoteAppears(quote, snap.text))
      throw new HttpError(
        422,
        `That sentence does not appear in the current version of ${doc.name}${snap.versionLabel ? ` (${snap.versionLabel})` : ""}. Copy it exactly from the document.`,
      );
    const missing = numbersMissingFromQuote(rule.params, quote);
    if (missing.length)
      throw new HttpError(
        422,
        `The quote must contain every number in the rule. Missing: ${missing.join(", ")}`,
      );
    const ev = await tx.ruleEvidence.create({
      data: {
        orgId: ctx.orgId,
        lineageKey: rule.lineageKey,
        kind: "verify",
        tier: "T1",
        channel: "document",
        documentId,
        snapshotId: snap.id,
        section: input.section?.trim() || rule.sourceSection,
        quote,
        textSha256: snap.textSha256,
        reviewerId: ctx.userId,
        note: input.note?.trim() || null,
      },
    });
    await audit(tx, {
      action: "payor_rule:verify",
      entityType: "PayorRule",
      entityId: ruleId,
      meta: { lineageKey: rule.lineageKey, evidenceId: ev.id, documentId, quoteSha: sha256(quote) },
    });
    return ev;
  });
}

export async function revokeRuleVerification(ctx: OrgCtx, ruleId: string, note: string | null) {
  requirePermission(ctx.role, "payor:verify");
  return withOrg(ctx, async (tx) => {
    const rule = await tx.payorRule.findUniqueOrThrow({ where: { id: ruleId } });
    const ev = await tx.ruleEvidence.create({
      data: {
        orgId: ctx.orgId,
        lineageKey: rule.lineageKey,
        kind: "revoke",
        tier: "-",
        channel: "manual",
        reviewerId: ctx.userId,
        note: note?.trim() || null,
      },
    });
    await audit(tx, {
      action: "payor_rule:revoke",
      entityType: "PayorRule",
      entityId: ruleId,
      meta: { lineageKey: rule.lineageKey, evidenceId: ev.id },
    });
    return ev;
  });
}
