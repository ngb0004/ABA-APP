import type { Tx } from "../db";
import { ageYears, toDay, type Day } from "../dates";
import type { EvalContext } from "../payors/context";
import { evaluateRules, planTypeFit, scopeFindings } from "../payors/evaluate";
import { sectionDone, sectionsForTopic } from "../plan/sections";
import type { PlanType, Rule, RuleType } from "../payors/types";
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

/**
 * The rules that can apply to one insurance: every rule for its payor except those limited to
 * other plan types. "maybe" fits stay in. Use this wherever rules turn into work for the BCBA
 * (required plan items, calendar deadlines); the evaluator keeps the full list so it can show n/a.
 */
export async function loadApplicableRules(
  tx: Tx,
  insurance: { payorId: string; planType: string },
): Promise<Rule[]> {
  return applicableRules(await loadRules(tx, insurance.payorId), insurance.planType as PlanType);
}

export const applicableRules = (rules: Rule[], planType: PlanType) =>
  rules.filter((r) => planTypeFit(r, planType) !== "no");

type RuleRow = {
  id: string;
  payor: { key: string };
  type: string;
  params: unknown;
  sourceDocumentId: string | null;
  sourceSection: string | null;
  sourcePage?: string | null;
  sourceQuote?: string | null;
  notes: string | null;
  inheritedFrom: string | null;
  lineageKey: string;
  planTypes?: string[];
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
  // A blank lineage (rows from before the library sync) never picks up anyone's evidence.
  const lineages = [...new Set(rows.map((r) => r.lineageKey).filter(Boolean))];
  const evidence = lineages.length
    ? await tx.ruleEvidence.findMany({
        where: { lineageKey: { in: lineages } },
        orderBy: { createdAt: "asc" },
      })
    : [];
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
  const snapSelect = {
    id: true,
    documentId: true,
    resolvedUrl: true,
    textSha256: true,
    effectiveDate: true,
    versionLabel: true,
    nextRevision: true,
    revisions: true,
  } as const;
  // Latest snapshot per document, plus the (older) snapshots evidence was recorded against.
  const latestRows = await tx.payorDocumentSnapshot.findMany({
    where: { documentId: { in: docIds } },
    distinct: ["documentId"],
    orderBy: [{ documentId: "asc" }, { fetchedAt: "desc" }],
    select: snapSelect,
  });
  const latest = new Map(latestRows.map((s) => [s.documentId, s]));
  const refIds = [...new Set(evidence.map((e) => e.snapshotId).filter((x): x is string => !!x))];
  const byId = new Map(
    (refIds.length
      ? await tx.payorDocumentSnapshot.findMany({
          where: { id: { in: refIds } },
          select: { id: true, effectiveDate: true },
        })
      : []
    ).map((s) => [s.id, s]),
  );
  const textMemo = new Map<string, string>();
  const latestText = async (snapId: string) => {
    if (!textMemo.has(snapId))
      textMemo.set(
        snapId,
        (await tx.payorDocumentSnapshot.findUniqueOrThrow({ where: { id: snapId }, select: { text: true } }))
          .text,
      );
    return textMemo.get(snapId)!;
  };

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
    const ev = r.lineageKey ? evidence.filter((e) => e.lineageKey === r.lineageKey) : [];
    let current: (typeof ev)[number] | null = null;
    for (const e of ev) current = e.kind === "verify" ? e : null;
    // A verified rule is judged against the document it was verified with.
    const docId = current?.documentId ?? r.sourceDocumentId;
    const doc = docId ? docs.get(docId) : undefined;
    const snap = docId ? latest.get(docId) : undefined;
    let quoteStillPresent: boolean | undefined;
    if (current && snap && current.textSha256 && current.textSha256 !== snap.textSha256)
      quoteStillPresent = quoteAppears(current.quote, await latestText(snap.id));
    // Watch both the rule's cited section and the section it was verified under.
    const section =
      [...new Set([r.sourceSection, current?.section].filter((x): x is string => !!x))].join("/") || null;
    const trust = computeTrust({
      section,
      doc: doc
        ? {
            name: doc.name,
            secondary: doc.secondary,
            citedEffectiveDate: doc.effectiveDate ? toDay(doc.effectiveDate) : null,
            health: doc.health,
            lastError: doc.lastError,
            lastCheckedAt: doc.lastCheckedAt?.toISOString() ?? null,
            watched: !!doc.locator,
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
        url: snap?.resolvedUrl || doc?.url || null,
        page: r.sourcePage ?? null,
        quote: r.sourceQuote ?? null,
      },
      notes: r.notes,
      inheritedFrom: r.inheritedFrom,
      planTypes: r.planTypes ?? [],
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
      payors: { include: { payor: true } },
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
  const goals = await tx.goal.findMany({
    where: { clientId },
    select: { _count: { select: { dataPoints: true } } },
  });
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
      planType: (primary?.planType ?? "unknown") as PlanType,
      planState: primary?.planState ?? null,
    },
    payor: primary
      ? {
          key: primary.payor.key,
          name: primary.payor.name,
          states: primary.payor.states,
          lineOfBusiness: primary.payor.lineOfBusiness,
        }
      : null,
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
            plan.sections.some(
              (s) =>
                sectionsForTopic(
                  "evaluation_date",
                  plan.sections.map((x) => x.key),
                )?.includes(s.key) && s.content.trim().length > 0,
            ),
          allApprovedByBcba: plan.sections.length > 0 && plan.sections.every((s) => sectionDone(s.state)),
          goalsHaveData: goals.length > 0 && goals.every((g) => g._count.dataPoints > 0),
        }
      : null,
    offices,
    packetSubmitted: plan?.packet?.status === "submitted",
  };
  return { ctx, payorId: primary?.payorId ?? null, authorizationId: auth?.id ?? null };
}

export async function evaluateClientRules(tx: Tx, clientId: string, asOf: Day, planId?: string | null) {
  const { ctx, payorId } = await buildEvalContext(tx, clientId, asOf, planId);
  if (!payorId) return { ctx, results: [], scope: [] };
  const rules = await loadRules(tx, payorId);
  return { ctx, results: evaluateRules(rules, ctx), scope: scopeFindings(rules, ctx) };
}
