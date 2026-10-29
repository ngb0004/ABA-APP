/**
 * A rule's trust status, computed from evidence and source health. Never typed in.
 *
 * - unsourced: no source document at all.
 * - unverified: an official source not yet checked, or only a secondary source.
 * - stale: the cited section changed after the version the rule cites or was
 *   verified against, the quoted sentence disappeared, the source is broken,
 *   or the verification expired.
 * - verified: a human matched a sentence in the current official document
 *   (or written payor correspondence), and nothing since has invalidated it.
 */
import type { TrustStatus } from "../payors/types";
import type { RevisionRow } from "./parsers";
import { sectionsOverlap } from "./sections";

export type DocState = {
  name: string;
  secondary: boolean;
  /** The version the rule text was written against. */
  citedEffectiveDate: string | null;
  health: string;
  lastError: string | null;
  lastCheckedAt: string | null;
  /** False for documents a BCBA uploads by hand: nothing checks them automatically. */
  watched?: boolean;
};
export type SnapshotState = {
  id: string;
  textSha256: string;
  effectiveDate: string | null;
  versionLabel: string | null;
  nextRevision: string | null;
  revisions: RevisionRow[];
};
export type EvidenceState = {
  kind: "verify" | "revoke";
  tier: string;
  createdAt: string;
  reviewerId: string | null;
  snapshotId: string | null;
  textSha256: string | null;
  snapshotEffectiveDate: string | null;
  quote: string;
  section: string | null;
};
export type Trust = {
  status: TrustStatus;
  tier: string | null;
  reasons: string[];
  verifiedUntil: string | null;
  verifiedAt: string | null;
};

export const VERIFIED_CEILING_DAYS: Record<string, number> = { T1: 180, T2: 90 };
/** If the watcher hasn't checked a source in this long, its verified rules fall back to "needs re-check". */
export const MAX_UNCHECKED_DAYS = 7;
/** Nothing watches an uploaded document for changes, so its verifications last at most this long. */
export const UNWATCHED_CEILING_DAYS = 90;

const addDays = (iso: string, n: number) =>
  new Date(Date.parse(iso) + n * 86_400_000).toISOString().slice(0, 10);
const changesSince = (snap: SnapshotState | null, since: string | null, section: string | null) =>
  (snap?.revisions ?? []).filter(
    (r) => (!since || r.date > since) && (!section || sectionsOverlap(section, r.section)),
  );
const describe = (rows: RevisionRow[]) =>
  rows.slice(0, 5).map((r) => `Section ${r.section} changed ${r.date}: ${r.description}`);

export function computeTrust(input: {
  section: string | null;
  doc: DocState | null;
  latest: SnapshotState | null;
  evidence: EvidenceState[];
  /** Whether the quoted sentence still appears in the latest snapshot (checked by the caller when needed). */
  quoteStillPresent?: boolean;
  /** Same-topic changes logged in the payor's other official documents (see relatedChanges()). */
  relatedChanges?: string[];
  today: string;
}): Trust {
  const { doc, latest, section, today } = input;
  if (!doc)
    return {
      status: "unsourced",
      tier: null,
      reasons: ["No source document recorded"],
      verifiedUntil: null,
      verifiedAt: null,
    };

  // The latest verify that has not been revoked afterwards.
  let current: EvidenceState | null = null;
  for (const e of [...input.evidence].sort((a, b) => a.createdAt.localeCompare(b.createdAt)))
    current = e.kind === "verify" ? e : null;

  if (current) {
    const reasons: string[] = [];
    const watched = doc.watched !== false;
    const days = VERIFIED_CEILING_DAYS[current.tier] ?? 90;
    const ceiling = addDays(
      current.createdAt.slice(0, 10),
      watched ? days : Math.min(days, UNWATCHED_CEILING_DAYS),
    );
    const verifiedUntil = [ceiling, latest?.nextRevision].filter(Boolean).sort()[0]!;
    if (doc.health === "broken")
      reasons.push(
        `Source is unreachable${doc.lastError ? ` (${doc.lastError})` : ""}; re-check when it is back`,
      );
    if (!watched) {
      // Uploaded by hand: expiry (above) is the only clock.
    } else if (!doc.lastCheckedAt) reasons.push("The source has never been checked automatically");
    else if (today > addDays(doc.lastCheckedAt.slice(0, 10), MAX_UNCHECKED_DAYS))
      reasons.push(`The source has not been checked since ${doc.lastCheckedAt.slice(0, 10)}`);
    if (latest && current.textSha256 && latest.textSha256 !== current.textSha256) {
      const touched = changesSince(latest, current.snapshotEffectiveDate, section);
      if (touched.length) reasons.push(...describe(touched));
      else if (input.quoteStillPresent === false)
        reasons.push("The document changed and the quoted sentence no longer appears");
    }
    if (today >= verifiedUntil)
      reasons.push(`Verification expired ${verifiedUntil}; re-check the current document`);
    if (reasons.length)
      return { status: "stale", tier: current.tier, reasons, verifiedUntil, verifiedAt: current.createdAt };
    return {
      status: "verified",
      tier: current.tier,
      reasons: [],
      verifiedUntil,
      verifiedAt: current.createdAt,
    };
  }

  const secondaryNote = `Only a secondary source (${doc.name}); verify against an official document`;
  if (doc.secondary && input.relatedChanges?.length)
    return {
      status: "stale",
      tier: "T5",
      reasons: [...input.relatedChanges.slice(0, 3), secondaryNote],
      verifiedUntil: null,
      verifiedAt: null,
    };
  if (doc.secondary)
    return {
      status: "unverified",
      tier: "T5",
      reasons: [secondaryNote],
      verifiedUntil: null,
      verifiedAt: null,
    };
  if (doc.health === "broken")
    return {
      status: "stale",
      tier: null,
      reasons: [
        `Cited document is unreachable${doc.lastError ? ` (${doc.lastError})` : ""}${latest ? `; showing the last version fetched (${latest.versionLabel ?? latest.effectiveDate ?? "undated"})` : ""}`,
      ],
      verifiedUntil: null,
      verifiedAt: null,
    };
  const touched = changesSince(latest, doc.citedEffectiveDate, section);
  if (touched.length)
    return { status: "stale", tier: null, reasons: describe(touched), verifiedUntil: null, verifiedAt: null };
  const newer =
    latest?.effectiveDate && doc.citedEffectiveDate && latest.effectiveDate > doc.citedEffectiveDate;
  if (newer && !(latest!.revisions.length && section))
    return {
      status: "stale",
      tier: null,
      reasons: [
        `New version since the one cited (${latest!.versionLabel ?? latest!.effectiveDate}); re-check`,
      ],
      verifiedUntil: null,
      verifiedAt: null,
    };
  // Documents without a change log or version date: any content change since we started watching needs a re-check.
  if (doc.health === "changed" && latest && !latest.revisions.length && !newer)
    return {
      status: "stale",
      tier: null,
      reasons: ["The document's content changed since it was first fetched; re-check the rule against it"],
      verifiedUntil: null,
      verifiedAt: null,
    };
  const note = newer
    ? [
        `New version ${latest!.versionLabel ?? latest!.effectiveDate}; its change log lists nothing for section ${section}`,
      ]
    : [];
  return {
    status: "unverified",
    tier: null,
    reasons: [
      doc.watched === false && !latest
        ? "Official document with no public copy: upload it under Sources, then verify"
        : "Cited official document, not yet checked",
      ...note,
    ],
    verifiedUntil: null,
    verifiedAt: null,
  };
}

/**
 * Topics that tie a rule without a section (e.g., from a checklist) to entries in
 * a payor's change log. Deliberately narrow: a false alarm teaches people to ignore alarms.
 */
export const RELATED_TOPICS: Partial<Record<string, RegExp>> = {
  supervision_ratio: /supervis/i,
  staff_credential: /licens|credential|certif/i,
  plan_content: /treatment plan|plan of care|template/i,
};

export function relatedChanges(
  ruleType: string,
  docs: { name: string; citedEffectiveDate: string | null; revisions: RevisionRow[] }[],
): string[] {
  const topic = RELATED_TOPICS[ruleType];
  if (!topic) return [];
  return docs.flatMap((d) =>
    d.revisions
      .filter((r) => (!d.citedEffectiveDate || r.date > d.citedEffectiveDate) && topic.test(r.description))
      .map((r) => `Related change in ${d.name}: section ${r.section} (${r.date}) ${r.description}`),
  );
}
