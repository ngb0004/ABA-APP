import type { Tx } from "../db";
import { ageYears, toDay, type Day } from "../dates";
import type { EvalContext } from "../payors/context";
import { evaluateRules } from "../payors/evaluate";
import type { Rule, RuleType } from "../payors/types";
import type { RevisionRow } from "../rules-watch/parsers";
import { computeTrust, relatedChanges, type SnapshotState } from "../rules-watch/status";
import { quoteAppears } from "../rules-watch/text";
import type { UnitBasis } from "../utilization";

export async function loadRules(tx: Tx, payorId: string): Promise<Rule[]> {
  const rows = await tx.payorRule.findMany({
    where: { payorId },
    include: { payor: true },
    orderBy: { ordinal: "asc" },
  });
  return withTrust(tx, rows);
}

type RuleRow = {
  id: string;
  payor: { key: string };
  type: string;
  params: unknown;
  sourceDocumentId: string | null;
  sourceSection: string | null;
  notes: string | null;
  inheritedFrom: string | null;
  lineageKey: string;
};

const snapshotState = (s: {
  id: string;
  textSha256: string;
  effectiveDate: Date | null;
  versionLabel: string | null;
  nextRevision: Date | null;
  revisions: unknown;
}): SnapshotState => ({
  id: s.id,
  textSha256: s.textSha256,
  effectiveDate: s.effectiveDate ? toDay(s.effectiveDate) : null,
  versionLabel: s.versionLabel,
  nextRevision: s.nextRevision ? toDay(s.nextRevision) : null,
  revisions: (s.revisions as RevisionRow[]) ?? [],
});

/** Attach computed trust (evidence + source health) to rule rows, in a few batched queries. */
export async function withTrust(tx: Tx, rows: RuleRow[], today: Day = toDay(new Date())): Promise<Rule[]> {
  if (!rows.length) return [];
  const evidence = await tx.ruleEvidence.findMany({
    where: { lineageKey: { in: [...new Set(rows.map((r) => r.lineageKey))] } },
    orderBy: { createdAt: "asc" },
  });
  const docIds = [
    ...new Set(
      [...rows.map((r) => r.sourceDocumentId), ...evidence.map((e) => e.documentId)].filter(
        (x): x is string => !!x,
      ),
    ),
  ];
  const docs = new Map(
    (await tx.payorDocument.findMany({ where: { id: { in: docIds } } })).map((d) => [d.id, d]),
  );
  const snaps = await tx.payorDocumentSnapshot.findMany({
    where: { documentId: { in: docIds } },
    orderBy: { fetchedAt: "desc" },
    select: {
      id: true,
      documentId: true,
      resolvedUrl: true,
      textSha256: true,
      effectiveDate: true,
      versionLabel: true,
      nextRevision: true,
      revisions: true,
    },
  });
  const latest = new Map<string, (typeof snaps)[number]>();
  for (const s of snaps) if (!latest.has(s.documentId)) latest.set(s.documentId, s);
  const byId = new Map(snaps.map((s) => [s.id, s]));

  // Each payor's official documents (cited by any of its rules), for same-topic change detection.
  const officialByPayor = new Map<
    string,
    { name: string; citedEffectiveDate: string | null; revisions: RevisionRow[] }[]
  >();
  for (const r of rows) {
    const d = r.sourceDocumentId ? docs.get(r.sourceDocumentId) : undefined;
    const snap = d ? latest.get(d.id) : undefined;
    if (!d || d.secondary || !snap) continue;
    const list = officialByPayor.get(r.payor.key) ?? [];
    if (!list.some((x) => x.name === d.name))
      list.push({
        name: d.name,
        citedEffectiveDate: d.effectiveDate ? toDay(d.effectiveDate) : null,
        revisions: (snap.revisions as RevisionRow[]) ?? [],
      });
    officialByPayor.set(r.payor.key, list);
  }

  const out: Rule[] = [];
  for (const r of rows) {
    const ev = evidence.filter((e) => e.lineageKey === r.lineageKey);
    let current: (typeof ev)[number] | null = null;
    for (const e of ev) current = e.kind === "verify" ? e : null;
    // A verified rule is judged against the document it was verified with.
    const docId = current?.documentId ?? r.sourceDocumentId;
    const doc = docId ? docs.get(docId) : undefined;
    const snap = docId ? latest.get(docId) : undefined;
    let quoteStillPresent: boolean | undefined;
    if (current && snap && current.textSha256 && current.textSha256 !== snap.textSha256) {
      const text = await tx.payorDocumentSnapshot.findUniqueOrThrow({
        where: { id: snap.id },
        select: { text: true },
      });
      quoteStillPresent = quoteAppears(current.quote, text.text);
    }
    const trust = computeTrust({
      section: current?.section ?? r.sourceSection,
      doc: doc
        ? {
            name: doc.name,
            secondary: doc.secondary,
            citedEffectiveDate: doc.effectiveDate ? toDay(doc.effectiveDate) : null,
            health: doc.health,
            lastError: doc.lastError,
            lastCheckedAt: doc.lastCheckedAt?.toISOString() ?? null,
          }
        : null,
      latest: snap ? snapshotState(snap) : null,
      evidence: ev.map((e) => {
        const es = e.snapshotId ? byId.get(e.snapshotId) : undefined;
        return {
          kind: e.kind as "verify" | "revoke",
          tier: e.tier,
          createdAt: e.createdAt.toISOString(),
          reviewerId: e.reviewerId,
          snapshotId: e.snapshotId,
          textSha256: e.textSha256,
          snapshotEffectiveDate: es?.effectiveDate ? toDay(es.effectiveDate) : null,
          quote: e.quote,
          section: e.section,
        };
      }),
      quoteStillPresent,
      relatedChanges:
        doc?.secondary || !r.sourceSection
          ? relatedChanges(r.type, officialByPayor.get(r.payor.key) ?? [])
          : [],
      today,
    });
    out.push({
      id: r.id,
      payorKey: r.payor.key,
      lineageKey: r.lineageKey,
      type: r.type as RuleType,
      params: r.params as Record<string, unknown>,
      verified: trust.status === "verified",
      trust,
      source: {
        key: doc?.key ?? null,
        name: doc?.name ?? null,
        version: snap?.versionLabel ?? doc?.version ?? null,
        section: current?.section ?? r.sourceSection,
        // Link to the version actually fetched (e.g., this quarter's Georgia manual), else the cited URL.
        url: snap?.resolvedUrl ?? doc?.url ?? null,
      },
      notes: r.notes,
      inheritedFrom: r.inheritedFrom,
    });
  }
  return out;
}

/** Builds the evaluator context for a client (and optionally a plan). */
export async function buildEvalContext(
  tx: Tx,
  clientId: string,
  asOf: Day,
  planId?: string | null,
): Promise<{ ctx: EvalContext; payorId: string | null; authorizationId: string | null }> {
  const client = await tx.client.findUniqueOrThrow({
    where: { id: clientId },
    include: {
      payors: true,
      attachments: true,
      authorizations: { include: { units: true }, orderBy: { endDate: "desc" } },
    },
  });
  const org = await tx.org.findUniqueOrThrow({ where: { id: client.orgId } });
  const plan = planId
    ? await tx.plan.findUnique({ where: { id: planId }, include: { sections: true, packet: true } })
    : null;
  const auth = plan?.authorizationId
    ? (client.authorizations.find((a) => a.id === plan.authorizationId) ?? client.authorizations[0])
    : client.authorizations[0];
  const sessions = auth ? await tx.serviceSession.findMany({ where: { authorizationId: auth.id } }) : [];
  const diagnoses = await tx.diagnosis.findMany({ where: { clientId } });
  const primary = client.payors.find((p) => p.priority === "primary") ?? client.payors[0];
  const offices = (org.settings as { offices?: { state: string; address: string }[] }).offices ?? [];
  const ctx: EvalContext = {
    asOf,
    client: {
      ageYears: ageYears(toDay(client.dob), asOf),
      serviceState: (client.serviceAddress as { state?: string }).state ?? "",
      hasIep: client.hasIep,
      hasSecondaryPayor: client.payors.some((p) => p.priority === "secondary"),
      events: client.events,
    },
    authorization: auth
      ? {
          kind: auth.kind as "initial" | "reauth",
          startDate: toDay(auth.startDate),
          endDate: toDay(auth.endDate),
          units: auth.units.map((u) => ({
            cptCode: u.cptCode,
            approvedUnits: u.approvedUnits,
            unitBasis: u.unitBasis as UnitBasis,
          })),
        }
      : null,
    sessions: sessions.map((s) => ({
      cptCode: s.cptCode,
      date: toDay(s.date),
      units: s.units,
      inPerson: s.inPerson,
      providerId: s.providerId,
      providerRole: s.providerRole,
      startMinute: s.startMinute,
    })),
    attachments: client.attachments.map((a) => ({
      kind: a.kind,
      title: a.title,
      documentDate: a.documentDate ? toDay(a.documentDate) : null,
    })),
    plan: plan
      ? {
          type: plan.type as "initial" | "reauth",
          sections: plan.sections.map((s) => ({
            key: s.key,
            state: s.state,
            hasContent: s.content.trim().length > 0,
          })),
          includesEvaluationDate:
            diagnoses.some((d) => d.evaluationDate) &&
            plan.sections.some((s) => s.key === "assessment" && s.content.trim().length > 0),
          allApprovedByBcba: plan.sections.length > 0 && plan.sections.every((s) => s.state === "approved"),
        }
      : null,
    offices,
    packetSubmitted: plan?.packet?.status === "submitted",
  };
  return { ctx, payorId: primary?.payorId ?? null, authorizationId: auth?.id ?? null };
}

export async function evaluateClientRules(tx: Tx, clientId: string, asOf: Day, planId?: string | null) {
  const { ctx, payorId } = await buildEvalContext(tx, clientId, asOf, planId);
  if (!payorId) return { ctx, results: [] };
  const rules = await loadRules(tx, payorId);
  return { ctx, results: evaluateRules(rules, ctx) };
}
