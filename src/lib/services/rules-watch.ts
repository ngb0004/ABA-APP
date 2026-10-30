/**
 * Rules Watch services: check payor sources, and verify or revoke rules with evidence.
 */
import { Prisma } from "@prisma/client";
import { audit, sha256 } from "../audit";
import { forEachOrg, requireCurator } from "../auth/curator";
import { db, withOrg, type OrgCtx, type Tx } from "../db";
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
import { isDemo } from "../demo";
import { extractDocumentText, MAX_BYTES, MIN_TEXT } from "../rules-watch/fetch";
import {
  credentialsMissingFromQuote,
  looksLikeClientRecord,
  normalizeText,
  numbersMissingFromQuote,
  quoteAppears,
  quoteIsSubstantial,
  textSha256,
} from "../rules-watch/text";

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
        // Any text change is kept as a snapshot, so a deleted sentence is noticed even when the
        // payor's version label did not move. Only a new label (or new text, for unlabeled
        // documents) counts as a "new version" alert.
        const textChanged = !latest || r.textSha256 !== latest.textSha256;
        const isNew = !latest || (r.versionLabel ? r.versionLabel !== latest.versionLabel : textChanged);
        if (textChanged) {
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

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * A curator uploads the official copy of a payor document that has no public URL
 * (for example, a provider handbook behind a portal), so rules can be verified against it.
 * Public payor publications only: anything that looks like a client's record is rejected and not stored.
 */
export async function uploadOfficialCopy(
  ctx: OrgCtx,
  documentId: string,
  input: { data: Buffer; versionLabel?: string | null; effectiveDate?: string | null },
) {
  requirePermission(ctx.role, "payor:verify");
  await requireCurator(ctx);
  if (isDemo()) throw new HttpError(403, "Uploading payor documents is turned off on the demo site.");
  const doc = await withOrg(ctx, (tx) => tx.payorDocument.findUniqueOrThrow({ where: { id: documentId } }));
  if (doc.secondary)
    throw new HttpError(422, `${doc.name} is a secondary source. Upload an official payor document instead.`);
  if (doc.locator) throw new HttpError(409, `${doc.name} is fetched automatically from the payor's site.`);
  // Every rejected upload is recorded (reason and size only, never the file's text).
  const reject = async (
    status: number,
    reason: string,
    message: string,
    extra: Record<string, unknown> = {},
  ) => {
    await withOrg(ctx, (tx) =>
      audit(tx, {
        action: "source:upload_rejected",
        entityType: "PayorDocument",
        entityId: documentId,
        meta: { key: doc.key, reason, byteLength: input.data.length, ...extra },
      }),
    );
    return new HttpError(status, message);
  };
  if (input.data.length > MAX_BYTES) throw await reject(413, "too_large", "File too large");
  if (input.data.subarray(0, 5).toString() !== "%PDF-")
    throw await reject(422, "not_pdf", "Upload the payor's PDF file.");
  const effectiveDate = input.effectiveDate?.trim() || null;
  // "2026-13-01" is an invalid Date: check before formatting it, which would throw.
  const parsed = effectiveDate ? new Date(`${effectiveDate}T00:00:00Z`) : null;
  if (
    effectiveDate &&
    !(
      ISO_DAY.test(effectiveDate) &&
      parsed &&
      !Number.isNaN(parsed.getTime()) &&
      toDay(parsed) === effectiveDate
    )
  )
    throw new HttpError(422, "Effective date must be a date (YYYY-MM-DD)");
  let text: string;
  try {
    text = normalizeText(await extractDocumentText(input.data, "application/pdf", "upload.pdf"));
  } catch {
    throw await reject(422, "unreadable", "Could not read text from that PDF.");
  }
  if (text.length < MIN_TEXT)
    throw await reject(
      422,
      "too_little_text",
      "That PDF has almost no text (it may be a scan). Upload the payor's text PDF.",
    );
  const sha = textSha256(text);
  if (looksLikeClientRecord(text))
    throw await reject(
      422,
      "looks_like_client_record",
      "That file looks like it contains a client's information (a name, date of birth, or member ID). Upload only the payor's public publication.",
      { textSha256: sha },
    );
  const versionLabel = input.versionLabel?.trim().slice(0, 120) || null;
  // The same official copy goes to every practice's copy of the document (same key, still upload-only).
  const results = await forEachOrg(ctx, async (tx, orgId) => {
    const target =
      orgId === ctx.orgId
        ? doc
        : await tx.payorDocument.findFirst({
            where: { key: doc.key, secondary: false, locator: { equals: Prisma.AnyNull } },
          });
    if (!target) return null;
    const documentId = target.id;
    const latest = await tx.payorDocumentSnapshot.findFirst({
      where: { documentId },
      orderBy: { fetchedAt: "desc" },
      select: { textSha256: true },
    });
    if (latest?.textSha256 === sha) {
      await audit(tx, {
        action: "source:upload_unchanged",
        entityType: "PayorDocument",
        entityId: documentId,
        meta: { key: doc.key, textSha256: sha },
      });
      return { snapshotId: null, unchanged: true };
    }
    // A corrected copy uploaded without a date keeps the edition date of the copy before it.
    const priorDated = effectiveDate
      ? null
      : await tx.payorDocumentSnapshot.findFirst({
          where: { documentId, effectiveDate: { not: null } },
          orderBy: { fetchedAt: "desc" },
          select: { effectiveDate: true },
        });
    const edition = effectiveDate ?? (priorDated?.effectiveDate ? toDay(priorDated.effectiveDate) : null);
    const now = new Date();
    const snap = await tx.payorDocumentSnapshot.create({
      data: {
        orgId,
        documentId,
        fetchedAt: now,
        resolvedUrl: "",
        contentType: "application/pdf",
        byteLength: input.data.length,
        textSha256: sha,
        text,
        versionLabel,
        effectiveDate: edition ? new Date(`${edition}T00:00:00Z`) : null,
        origin: "upload",
        uploadedById: ctx.userId,
      },
    });
    const cited = target.effectiveDate ? toDay(target.effectiveDate) : null;
    await tx.payorDocument.update({
      where: { id: documentId },
      data: {
        // Newer edition than the one cited, or (undated) different text from the first copy: re-check.
        health: (edition && cited && edition > cited) || (!edition && latest) ? "changed" : "ok",
        lastError: null,
        lastCheckedAt: now,
        ...(latest ? { lastChangedAt: now } : {}),
      },
    });
    await audit(tx, {
      action: "source:uploaded",
      entityType: "PayorDocument",
      entityId: documentId,
      meta: { key: doc.key, textSha256: sha, byteLength: input.data.length, replaced: !!latest },
    });
    return { snapshotId: snap.id, unchanged: false };
  });
  return results[0]!;
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

/**
 * Verify a rule with proof (platform curators only): the reviewer pastes a sentence from the current
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
  await requireCurator(ctx);
  const checked = await withOrg(ctx, async (tx) => {
    const rule = await tx.payorRule.findUniqueOrThrow({ where: { id: ruleId } });
    if (!rule.lineageKey)
      throw new HttpError(409, "This rule has not been synced yet. Run the payor library sync first.");
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
    if (!quoteIsSubstantial(quote))
      throw new HttpError(422, "Paste the full sentence that states the rule (at least 4 words)");
    if (!quoteAppears(quote, snap.text))
      throw new HttpError(
        422,
        `That sentence does not appear in the current version of ${doc.name}${snap.versionLabel ? ` (${snap.versionLabel})` : ""}. Copy it exactly from the document.`,
      );
    const creds = credentialsMissingFromQuote(rule.params, quote);
    if (creds.length)
      throw new HttpError(
        422,
        `The quote must name every credential in the rule. Missing: ${creds.join(", ")}`,
      );
    const missing = numbersMissingFromQuote(rule.params, quote);
    if (missing.length)
      throw new HttpError(
        422,
        `The quote must contain every number in the rule. Missing: ${missing.join(", ")}`,
      );
    return {
      lineageKey: rule.lineageKey,
      docKey: doc.key,
      textSha256: snap.textSha256,
      quote,
      section: input.section?.trim() || rule.sourceSection,
      note: input.note?.trim() || null,
    };
  });
  // Once for every practice: recorded wherever that practice's current copy of the document is
  // the same text the quote was checked against. A practice with another copy is left for its
  // next source check (counted, so the curator can see it).
  const outcomes = await forEachOrg(ctx, (tx, orgId) =>
    recordVerification(tx, orgId, ctx, { ...checked, ruleId: orgId === ctx.orgId ? ruleId : null }),
  );
  const own = outcomes[0];
  if (!own || own === "different_copy")
    throw new HttpError(409, "The document changed while verifying. Try again.");
  return {
    ...own,
    practices: {
      verified: outcomes.filter((o) => typeof o === "object").length,
      differentCopy: outcomes.filter((o) => o === "different_copy").length,
    },
  };
}

async function recordVerification(
  tx: Tx,
  orgId: string,
  ctx: OrgCtx,
  c: {
    lineageKey: string;
    docKey: string;
    textSha256: string;
    quote: string;
    section: string | null;
    note: string | null;
    /** The rule verified, in the curator's own org; elsewhere, that org's rule of the same lineage. */
    ruleId: string | null;
  },
) {
  const rule = await tx.payorRule.findFirst({
    where: c.ruleId ? { id: c.ruleId } : { lineageKey: c.lineageKey },
    orderBy: { inheritedFrom: { sort: "desc", nulls: "first" } },
    select: { id: true },
  });
  const doc = await tx.payorDocument.findFirst({ where: { key: c.docKey }, select: { id: true } });
  if (!rule || !doc) return null;
  const snap = await tx.payorDocumentSnapshot.findFirst({
    where: { documentId: doc.id },
    orderBy: { fetchedAt: "desc" },
    select: { id: true, textSha256: true },
  });
  if (snap?.textSha256 !== c.textSha256) return "different_copy" as const;
  const ev = await tx.ruleEvidence.create({
    data: {
      orgId,
      lineageKey: c.lineageKey,
      kind: "verify",
      tier: "T1",
      channel: "document",
      documentId: doc.id,
      snapshotId: snap.id,
      section: c.section,
      quote: c.quote,
      textSha256: c.textSha256,
      reviewerId: ctx.userId,
      note: c.note,
    },
  });
  await audit(tx, {
    action: "payor_rule:verify",
    entityType: "PayorRule",
    entityId: rule.id,
    meta: { lineageKey: c.lineageKey, evidenceId: ev.id, documentId: doc.id, quoteSha: sha256(c.quote) },
  });
  return ev;
}

/** Withdraw a verification (platform curators only). */
export async function revokeRuleVerification(ctx: OrgCtx, ruleId: string, note: string | null) {
  requirePermission(ctx.role, "payor:verify");
  await requireCurator(ctx);
  const lineageKey = await withOrg(ctx, async (tx) => {
    const rule = await tx.payorRule.findUniqueOrThrow({ where: { id: ruleId } });
    if (!rule.lineageKey)
      throw new HttpError(409, "This rule has not been synced yet. Run the payor library sync first.");
    return rule.lineageKey;
  });
  // Withdrawn in every practice that has the rule (see forEachOrg).
  const evs = await forEachOrg(ctx, async (tx, orgId) => {
    const rule =
      orgId === ctx.orgId
        ? { id: ruleId }
        : await tx.payorRule.findFirst({ where: { lineageKey }, select: { id: true } });
    if (!rule) return null;
    const ev = await tx.ruleEvidence.create({
      data: {
        orgId,
        lineageKey,
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
      entityId: rule.id,
      meta: { lineageKey, evidenceId: ev.id },
    });
    return ev;
  });
  return evs[0]!;
}
