import type { Metadata } from "next";
import { UploadForm } from "@/components/actions";
import { CheckSourcesButton } from "@/components/check-sources";
import { paramEntries, plural, STATUS_LEGEND, TIER_LEGEND } from "@/components/payor-display";
import { isDemo } from "@/lib/demo";
import { RuleSource, Status } from "@/components/status";
import { VerifyRule } from "@/components/verify-rule";
import { withOrg } from "@/lib/db";
import { toDay } from "@/lib/dates";
import { can, requirePermission } from "@/lib/permissions";
import type { RevisionRow } from "@/lib/rules-watch/parsers";
import { loadRules } from "@/lib/services/payors";
import { requirePageCtx } from "@/lib/server/page-session";

export const metadata: Metadata = { title: "Payor rules" };

export default async function PayorsPage() {
  const ctx = await requirePageCtx();
  requirePermission(ctx.role, "payor:read");
  const { payors, docs } = await withOrg(ctx, async (tx) => {
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
    return { payors, docs };
  });
  const canVerify = can(ctx.role, "payor:verify");
  const demo = isDemo();
  // The version the payor shows, else when we got the copy; null when there is no copy at all.
  const currentLabel = (s: { versionLabel: string | null; fetchedAt: Date; origin: string } | undefined) =>
    s ? (s.versionLabel ?? `${s.origin === "upload" ? "uploaded" : "fetched"} ${toDay(s.fetchedAt)}`) : null;
  const official = docs
    .filter((d) => !d.secondary)
    .map((d) => ({ id: d.id, name: d.name, current: currentLabel(d.snapshots[0]) }));
  const docByKey = new Map(docs.map((d) => [d.key, d]));
  const payorName = (key: string | null) => (key ? (payors.find((p) => p.key === key)?.name ?? key) : null);
  const all = payors.flatMap((p) => p.rules.filter((r) => !r.inheritedFrom));
  const count = (s: string) => all.filter((r) => r.trust?.status === s).length;

  return (
    <>
      <h1>Payor rules</h1>
      <p className="alert warn">
        Every rule carries its evidence. A rule becomes verified only when a BCBA matches it to a sentence in
        the current official document, and it falls back to &quot;needs re-check&quot; when that document
        changes, breaks, or reaches its next scheduled revision. Unverified rules only ever produce warnings.
      </p>
      <div className="row" style={{ marginBottom: 8 }}>
        <span className="badge verified">{count("verified")} verified</span>
        <span className="badge stale">{count("stale")} need re-check</span>
        <span className="badge unverified">{count("unverified")} unverified</span>
        <span className="badge unsourced">{count("unsourced")} no source</span>
      </div>
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
        {canVerify && <CheckSourcesButton />}
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
            <tbody>
              {docs.map((d) => {
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
                      {d.secondary && <div className="muted">Secondary source: cannot verify a rule</div>}
                      {uploadOnly && (
                        <div className="muted" data-testid={`upload-note-${d.key}`}>
                          No public copy to watch.{" "}
                          {s?.origin === "upload"
                            ? `Official copy uploaded ${toDay(s.fetchedAt)}.${demo ? "" : " Upload the new edition when the payor publishes one."}`
                            : demo
                              ? "Uploads are turned off on the demo site, so rules that cite this document cannot be verified here."
                              : "Upload the official copy to verify rules against it."}
                        </div>
                      )}
                      {uploadOnly && canVerify && !demo && (
                        <details>
                          <summary className="muted">Upload official copy</summary>
                          <p className="muted">
                            The payor&apos;s public publication only (PDF). Never upload a letter, a filled-in
                            form, or anything with a client&apos;s information.
                          </p>
                          <UploadForm
                            url={`/api/payors/sources/${d.id}/upload`}
                            accept="application/pdf,.pdf"
                            label="PDF from the payor"
                            testId={`upload-source-${d.key}`}
                            fields={[
                              { name: "version", label: "Edition or version", placeholder: "e.g. 2026" },
                              { name: "effectiveDate", label: "Effective date (if printed)", type: "date" },
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
          </table>
        </div>
      </div>

      {payors.map((p) => {
        const stale = p.rules.filter((r) => r.trust?.status === "stale").length;
        const verifiedCount = p.rules.filter((r) => r.verified).length;
        // Documents this payor's rules cite, listed first in the verify dialog.
        const citedIds = [
          ...new Set(p.rules.map((r) => (r.source.key ? docByKey.get(r.source.key)?.id : undefined))),
        ].filter((x): x is string => !!x);
        const secondaryOnly = p.rules.filter(
          (r) => r.source.key && docByKey.get(r.source.key)?.secondary,
        ).length;
        return (
          <details className="panel" key={p.id} open={stale > 0 && p.key === "ga_medicaid"}>
            <summary>
              <strong>{p.name}</strong>{" "}
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
                    <th>Source, evidence and verification</th>
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
                            {canVerify && !r.inheritedFrom && (
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
                              <span className="muted">Verified through {payorName(r.inheritedFrom)}</span>
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
    </>
  );
}
