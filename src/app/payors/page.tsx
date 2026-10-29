import { ActionButton, UploadForm } from "@/components/actions";
import { isDemo } from "@/lib/demo";
import { RuleSource, Status } from "@/components/status";
import { VerifyRule } from "@/components/verify-rule";
import { withOrg } from "@/lib/db";
import { toDay } from "@/lib/dates";
import { can, requirePermission } from "@/lib/permissions";
import type { RevisionRow } from "@/lib/rules-watch/parsers";
import { loadRules } from "@/lib/services/payors";
import { requirePageCtx } from "@/lib/server/page-session";

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
  const official = docs
    .filter((d) => !d.secondary)
    .map((d) => ({
      id: d.id,
      name: d.name,
      current: d.snapshots[0]?.versionLabel ?? (d.snapshots[0] ? "fetched" : null),
    }));
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
      <div className="row" style={{ marginBottom: 12 }}>
        <span className="badge verified">{count("verified")} verified</span>
        <span className="badge stale">{count("stale")} need re-check</span>
        <span className="badge unverified">{count("unverified")} unverified</span>
        <span className="badge unsourced">{count("unsourced")} no source</span>
      </div>

      <div className="panel">
        <h2 style={{ marginTop: 0 }}>Sources being watched</h2>
        <p className="muted">
          Checked daily. A new version, a broken link, or a change-log entry for a cited section flags the
          affected rules.
        </p>
        {canVerify && (
          <ActionButton url="/api/payors/sources/check" testId="check-sources">
            Check sources now
          </ActionButton>
        )}
        <div className="table-wrap">
          <table>
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
                return (
                  <tr key={d.id} data-doc={d.key}>
                    <td>
                      {s?.resolvedUrl || d.url ? (
                        <a href={s?.resolvedUrl || d.url!} target="_blank" rel="noreferrer">
                          {d.name}
                        </a>
                      ) : (
                        d.name
                      )}
                      {d.secondary && <div className="muted">Secondary source: cannot verify a rule</div>}
                      {!d.secondary && !d.locator && (
                        <div className="muted">
                          No public copy to watch.{" "}
                          {s?.origin === "upload"
                            ? `Official copy uploaded ${s.fetchedAt.toISOString().slice(0, 10)}; upload the new edition when the payor publishes one.`
                            : "Upload the official copy to verify rules against it."}
                        </div>
                      )}
                      {!d.secondary && !d.locator && canVerify && !demo && (
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
                            {changes.length} change(s) since the cited version
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
                    <td>
                      {!d.secondary && !d.locator && !s ? (
                        <span className="badge unknown">not uploaded</span>
                      ) : (
                        <Status s={d.secondary ? "n/a" : d.health} />
                      )}
                      {d.lastError && <div className="muted">{d.lastError}</div>}
                    </td>
                    <td className="muted">{d.version}</td>
                    <td className="muted">{s?.versionLabel ?? (s ? "fetched" : "-")}</td>
                    <td className="muted">
                      {d.lastCheckedAt
                        ? d.lastCheckedAt.toISOString().slice(0, 16).replace("T", " ")
                        : "never"}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {payors.map((p) => {
        const own = p.rules.filter((r) => !r.inheritedFrom);
        const stale = p.rules.filter((r) => r.trust?.status === "stale").length;
        return (
          <details className="panel" key={p.id} open={stale > 0 && p.key === "ga_medicaid"}>
            <summary>
              <strong>{p.name}</strong>{" "}
              <span className="muted">
                ({p.rules.length} rules{p.inherits ? `, inherits ${p.inherits}` : ""};{" "}
                {p.rules.filter((r) => r.verified).length} verified
                {stale ? `, ${stale} need re-check` : ""})
              </span>
            </summary>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Type</th>
                    <th>Parameters</th>
                    <th>Source and evidence</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {p.rules.map((r) => (
                    <tr key={r.id} data-rule={r.id}>
                      <td>{r.type.replace(/_/g, " ")}</td>
                      <td>
                        <code style={{ fontSize: 12 }}>{JSON.stringify(r.params)}</code>
                        {r.notes && <div className="muted">{r.notes}</div>}
                      </td>
                      <td>
                        <RuleSource r={r} />
                      </td>
                      <td>
                        {canVerify && !r.inheritedFrom && (
                          <VerifyRule
                            ruleId={r.id}
                            verified={r.verified}
                            documents={official}
                            defaultDocumentId={docs.find((d) => d.key === r.source.key)?.id ?? null}
                            section={r.source.section}
                            recordedQuote={r.source.quote}
                          />
                        )}
                        {r.inheritedFrom && <span className="muted">Verified through {r.inheritedFrom}</span>}
                      </td>
                    </tr>
                  ))}
                  {!own.length && !p.rules.length && (
                    <tr>
                      <td colSpan={4} className="muted">
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
