import type { Metadata } from "next";
import Link from "next/link";
import { UploadForm } from "@/components/actions";
import { CheckSourcesButton } from "@/components/check-sources";
import { paramEntries, plural, STATUS_LEGEND, TIER_LEGEND } from "@/components/payor-display";
import { isDemo } from "@/lib/demo";
import { RuleSource, Status } from "@/components/status";
import { ReportRule, ResolveReport } from "@/components/report-rule";
import { VerifyRule } from "@/components/verify-rule";
import { withOrg } from "@/lib/db";
import { toDay } from "@/lib/dates";
import { can, requirePermission } from "@/lib/permissions";
import type { RevisionRow } from "@/lib/rules-watch/parsers";
import { ALL_STATES, groupByState, homeGroups } from "@/lib/payors/groups";
import { LINE_OF_BUSINESS_LABELS, type LineOfBusiness } from "@/lib/payors/types";
import { loadRules } from "@/lib/services/payors";
import { listOpenReports } from "@/lib/services/rule-reports";
import { REPORT_REASON_LABELS } from "@/lib/payors/report-reasons";
import { orgSettings } from "@/lib/services/clients";
import { requirePageCtx } from "@/lib/server/page-session";

export const metadata: Metadata = { title: "Payor rules" };

export default async function PayorsPage({
  searchParams,
}: {
  searchParams: Promise<{ states?: string | string[] }>;
}) {
  const ctx = await requirePageCtx();
  requirePermission(ctx.role, "payor:read");
  const showAll = (await searchParams).states === "all";
  const { payors, docs, statesServed } = await withOrg(ctx, async (tx) => {
    const org = await tx.org.findUniqueOrThrow({ where: { id: ctx.orgId } });
    const list = await tx.payor.findMany({ orderBy: { name: "asc" } });
    const payors = await Promise.all(list.map(async (p) => ({ ...p, rules: await loadRules(tx, p.id) })));
    const docs = await tx.payorDocument.findMany({
      orderBy: { name: "asc" },
      include: {
        snapshots: {
          orderBy: { fetchedAt: "desc" },
          take: 1,
          select: {
            versionLabel: true,
            resolvedUrl: true,
            fetchedAt: true,
            revisions: true,
            effectiveDate: true,
            origin: true,
          },
        },
      },
    });
    return { payors, docs, statesServed: orgSettings(org.settings).statesServed };
  });
  const canCheck = can(ctx.role, "payor:verify");
  // Verifying rules is Yoma's curation job: only platform curators see those controls (the API re-checks).
  const curator = ctx.isPlatformCurator && canCheck;
  const reports = curator ? await listOpenReports(ctx) : [];
  const demo = isDemo();
  // The version the payor shows, else when we got the copy; null when there is no copy at all.
  const currentLabel = (s: { versionLabel: string | null; fetchedAt: Date; origin: string } | undefined) =>
    s ? (s.versionLabel ?? `${s.origin === "upload" ? "uploaded" : "fetched"} ${toDay(s.fetchedAt)}`) : null;
  const official = docs
    .filter((d) => !d.secondary)
    .map((d) => ({ id: d.id, name: d.name, current: currentLabel(d.snapshots[0]) }));
  const docByKey = new Map(docs.map((d) => [d.key, d]));
  const payorName = (key: string | null) => (key ? (payors.find((p) => p.key === key)?.name ?? key) : null);
  // State -> insurer: the states the practice serves and nationwide payors, unless asked for every state.
  const { groups, hiddenStates } = groupByState(payors, statesServed, showAll);
  const shown = [...new Set(groups.flatMap((g) => g.payors))];
  // A payor listing several states is shown in full once; its other groups point to it.
  const home = homeGroups(groups);
  const all = shown.flatMap((p) => p.rules.filter((r) => !r.inheritedFrom));
  const count = (s: string) => all.filter((r) => r.trust?.status === s).length;
  // Each source is listed once, under the first shown group whose payors cite it; uncited ones under All states.
  const listed = new Set<string>();
  const docGroups = groups.map((g) => {
    const cited = new Set(g.payors.flatMap((p) => p.rules.map((r) => r.source.key)));
    const own = docs.filter(
      (d) =>
        !listed.has(d.id) &&
        (cited.has(d.key) ||
          (g.key === ALL_STATES && !payors.some((p) => p.rules.some((r) => r.source.key === d.key)))),
    );
    for (const d of own) listed.add(d.id);
    return { ...g, docs: own };
  });

  return (
    <>
      <h1>Payor rules</h1>
      <p className="alert warn" data-testid="payor-intro">
        These rules come from each payor&apos;s official documents, and each one shows the sentence it came
        from. &quot;Unverified&quot; means Yoma&apos;s reviewers have not yet confirmed the rule against the
        current document, so it only ever produces warnings, never a block. If a rule doesn&apos;t match what
        you&apos;re seeing in a benefits check, an authorization letter, or a denial, use &quot;Report a
        problem&quot; on that rule.
      </p>
      {curator && (
        <div className="panel" data-testid="open-reports">
          <h2 style={{ marginTop: 0 }}>Open rule reports</h2>
          <p className="muted">
            You are signed in as a Yoma rule reviewer. Reports from every practice are listed here, and a
            verification or upload below applies to every practice.
          </p>
          {reports.length ? (
            <div className="table-wrap">
              <table className="stack">
                <thead>
                  <tr>
                    <th>Reported</th>
                    <th>Rule</th>
                    <th>What&apos;s wrong</th>
                    <th>Note</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {reports.map((r) => (
                    <tr key={r.id} data-report={r.id}>
                      <td className="muted" data-label="Reported">
                        {toDay(r.createdAt)}
                        {r.practice && <div>{r.practice}</div>}
                      </td>
                      <td data-label="Rule">
                        {r.payorName ?? "Unknown payor"}: {r.ruleType?.replace(/_/g, " ") ?? r.lineageKey}
                      </td>
                      <td data-label="What's wrong">{REPORT_REASON_LABELS[r.reason] ?? r.reason}</td>
                      <td data-label="Note" style={{ whiteSpace: "pre-wrap" }}>
                        {r.note || <span className="muted">None</span>}
                      </td>
                      <td data-label="">
                        <ResolveReport reportId={r.id} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="muted">No open reports.</p>
          )}
        </div>
      )}
      <div className="row" style={{ marginBottom: 8 }}>
        <span className="badge verified">{count("verified")} verified</span>
        <span className="badge stale">{count("stale")} need re-check</span>
        <span className="badge unverified">{count("unverified")} unverified</span>
        <span className="badge unsourced">{count("unsourced")} no source</span>
      </div>
      <p className="muted" data-testid="state-filter">
        {showAll ? (
          <>
            Showing every state. <Link href="/payors">Show only the states we serve</Link>
          </>
        ) : (
          <>
            Showing {statesServed.length ? statesServed.join(", ") : "no states yet"} and payors that apply in
            all states
            {hiddenStates.length ? ` (${plural(hiddenStates.length, "other state")} hidden)` : ""}.{" "}
            <Link href="/payors?states=all" data-testid="show-every-state">
              Show every state
            </Link>
            {" · "}
            <Link href="/settings">Change the states we serve</Link>
          </>
        )}
      </p>
      <details className="panel" data-testid="payor-legend">
        <summary>What the statuses and tiers mean</summary>
        <div className="grid2">
          <dl className="legend">
            {STATUS_LEGEND.map(([cls, name, text]) => (
              <div key={cls}>
                <dt>
                  <span className={`badge ${cls}`}>{name}</span>
                </dt>
                <dd>{text}</dd>
              </div>
            ))}
          </dl>
          <dl className="legend">
            <dt>Evidence tiers (strongest first)</dt>
            {TIER_LEGEND.map(([tier, text]) => (
              <dd key={tier}>
                <strong>{tier}</strong>: {text}
              </dd>
            ))}
            <dd className="muted">
              &quot;Verified until&quot; is the document&apos;s next scheduled revision, or the time limit for
              that tier of evidence, whichever comes first.
            </dd>
          </dl>
        </div>
      </details>

      <div className="panel">
        <h2 style={{ marginTop: 0 }}>Sources being watched</h2>
        <p className="muted">
          Checked daily. A new version, a broken link, or a change-log entry for a cited section flags the
          affected rules.
        </p>
        {canCheck && <CheckSourcesButton />}
        <div className="table-wrap">
          <table className="stack">
            <thead>
              <tr>
                <th>Document</th>
                <th>Status</th>
                <th>Rules cite</th>
                <th>Current</th>
                <th>Last checked</th>
              </tr>
            </thead>
            {docGroups
              .filter((g) => g.docs.length)
              .map((g) => (
                <tbody key={g.key} data-doc-group={g.key}>
                  <tr className="group-row">
                    <th colSpan={5}>{g.label}</th>
                  </tr>
                  {g.docs.map((d) => {
                    const s = d.snapshots[0];
                    const cited = d.effectiveDate ? toDay(d.effectiveDate) : null;
                    const changes = ((s?.revisions as RevisionRow[] | undefined) ?? []).filter(
                      (r) => !cited || r.date > cited,
                    );
                    const uploadOnly = !d.secondary && !d.locator;
                    return (
                      <tr key={d.id} data-doc={d.key}>
                        <td data-label="">
                          {s?.resolvedUrl || d.url ? (
                            <a href={s?.resolvedUrl || d.url!} target="_blank" rel="noreferrer">
                              {d.name}
                            </a>
                          ) : (
                            d.name
                          )}
                          {d.secondary && (
                            <div className="muted">Secondary source: never enough to verify a rule</div>
                          )}
                          {uploadOnly && (
                            <div className="muted" data-testid={`upload-note-${d.key}`}>
                              No public copy to watch.{" "}
                              {s?.origin === "upload"
                                ? `Official copy on file from ${toDay(s.fetchedAt)}.${curator && !demo ? " Upload the new edition when the payor publishes one." : ""}`
                                : curator && !demo
                                  ? "Upload the official copy to verify rules against it."
                                  : "Yoma's reviewers check this document by hand."}
                            </div>
                          )}
                          {uploadOnly && curator && !demo && (
                            <details>
                              <summary className="muted">Upload official copy</summary>
                              <p className="muted">
                                The payor&apos;s public publication only (PDF). Never upload a letter, a
                                filled-in form, or anything with a client&apos;s information.
                              </p>
                              <UploadForm
                                url={`/api/payors/sources/${d.id}/upload`}
                                accept="application/pdf,.pdf"
                                label="PDF from the payor"
                                testId={`upload-source-${d.key}`}
                                fields={[
                                  { name: "version", label: "Edition or version", placeholder: "e.g. 2026" },
                                  {
                                    name: "effectiveDate",
                                    label: "Effective date (if printed)",
                                    type: "date",
                                  },
                                ]}
                              />
                            </details>
                          )}
                          {changes.length > 0 && (
                            <details>
                              <summary className="muted">
                                {plural(changes.length, "change")} since the cited version
                              </summary>
                              <ul>
                                {changes.map((c, i) => (
                                  <li key={i}>
                                    {c.date} · section {c.section}: {c.description}
                                  </li>
                                ))}
                              </ul>
                            </details>
                          )}
                        </td>
                        <td data-label="Status">
                          {uploadOnly && !s ? (
                            <span className="badge unknown">not uploaded</span>
                          ) : (
                            <Status s={d.secondary ? "n/a" : d.health} />
                          )}
                          {d.lastError && <div className="muted">{d.lastError}</div>}
                        </td>
                        <td className="muted" data-label="Rules cite">
                          {d.version}
                        </td>
                        <td className="muted" data-label="Current">
                          {currentLabel(s) ?? "-"}
                        </td>
                        <td className="muted" data-label="Last checked">
                          {d.lastCheckedAt
                            ? d.lastCheckedAt.toISOString().slice(0, 16).replace("T", " ")
                            : d.locator
                              ? "never"
                              : "not checked automatically"}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              ))}
          </table>
        </div>
      </div>

      {groups.map((g) => (
        <section key={g.key} data-state-group={g.key} id={`state-${g.key}`}>
          <h2>
            {g.label}{" "}
            <span className="muted">
              ({plural(g.payors.length, "insurer")}
              {g.key === ALL_STATES ? ": TRICARE and national commercial policies" : ""})
            </span>
          </h2>
          {!g.payors.length && <p className="muted">No payor rules for this state yet.</p>}
          {g.payors.map((p) => {
            const homeGroup = home.get(p);
            if (homeGroup && homeGroup.key !== g.key)
              return (
                <p className="panel muted" key={p.id} data-payor-ref={p.key}>
                  <strong>{p.name}</strong>: its rules are listed under{" "}
                  <a href={`#state-${homeGroup.key}`}>{homeGroup.label}</a>.
                </p>
              );
            const stale = p.rules.filter((r) => r.trust?.status === "stale").length;
            const verifiedCount = p.rules.filter((r) => r.verified).length;
            // Documents this payor's rules cite, listed first in the curator's verify dialog.
            const citedIds = [
              ...new Set(p.rules.map((r) => (r.source.key ? docByKey.get(r.source.key)?.id : undefined))),
            ].filter((x): x is string => !!x);
            const secondaryOnly = p.rules.filter(
              (r) => r.source.key && docByKey.get(r.source.key)?.secondary,
            ).length;
            return (
              <details
                className="panel"
                key={p.id}
                data-payor={p.key}
                open={stale > 0 && p.key === "ga_medicaid"}
              >
                <summary>
                  <strong>{p.name}</strong>{" "}
                  <span className="badge info">
                    {LINE_OF_BUSINESS_LABELS[p.lineOfBusiness as LineOfBusiness] ?? p.lineOfBusiness}
                  </span>{" "}
                  <span className="muted">
                    ({plural(p.rules.length, "rule")}
                    {p.inherits ? `, inherits ${payorName(p.inherits)}` : ""}; {verifiedCount} verified
                    {stale ? `, ${stale} need re-check` : ""})
                  </span>
                </summary>
                {p.rules.length > 0 && secondaryOnly * 2 >= p.rules.length && (
                  <p className="alert warn">
                    {secondaryOnly} of these {plural(p.rules.length, "rule")} rest only on a secondary source,
                    which can never verify a rule. Treat them as reminders until an official document confirms
                    them.
                  </p>
                )}
                <div className="table-wrap">
                  <table className="rules-table">
                    <colgroup>
                      <col className="type" />
                      <col className="params" />
                      <col />
                    </colgroup>
                    <thead>
                      <tr>
                        <th>Type</th>
                        <th>Parameters</th>
                        <th>Source and status</th>
                      </tr>
                    </thead>
                    <tbody>
                      {p.rules.map((r) => {
                        const entries = paramEntries(r.params);
                        return (
                          <tr key={r.id} data-rule={r.id}>
                            <td>{r.type.replace(/_/g, " ")}</td>
                            <td>
                              {entries.length > 0 ? (
                                <dl className="params-list">
                                  {entries.map(([k, v]) => (
                                    <div key={k}>
                                      <dt>{k}:</dt> <dd>{v}</dd>
                                    </div>
                                  ))}
                                </dl>
                              ) : (
                                <span className="muted">None</span>
                              )}
                              {r.notes && <div className="muted">{r.notes}</div>}
                            </td>
                            <td>
                              <RuleSource r={r} inheritedName={payorName(r.inheritedFrom)} />
                              <div style={{ marginTop: 6 }}>
                                {curator && !r.inheritedFrom && (
                                  <VerifyRule
                                    ruleId={r.id}
                                    verified={r.verified}
                                    documents={official}
                                    payorDocumentIds={citedIds}
                                    defaultDocumentId={
                                      r.source.key ? (docByKey.get(r.source.key)?.id ?? null) : null
                                    }
                                    section={r.source.section}
                                    recordedQuote={r.source.quote}
                                  />
                                )}
                                {r.inheritedFrom && (
                                  <div className="muted">Status follows {payorName(r.inheritedFrom)}</div>
                                )}
                                {!curator && (
                                  <ReportRule ruleId={r.id} name={`rule: ${r.type.replace(/_/g, " ")}`} />
                                )}
                              </div>
                            </td>
                          </tr>
                        );
                      })}
                      {!p.rules.length && (
                        <tr>
                          <td colSpan={3} className="muted">
                            No rules
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </details>
            );
          })}
        </section>
      ))}
    </>
  );
}
