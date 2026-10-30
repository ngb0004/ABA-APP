import type { Metadata } from "next";
import Link from "next/link";
import { AddAssessment } from "@/components/add-assessment";
import { addOptions, assessmentFields, editValues } from "@/components/assessment-fields";
import { RowMenu } from "@/components/row-menu";
import {
  GROUP_LABELS,
  assessmentCatalog,
  catalogType,
  type AssessmentGroup,
} from "@/lib/assessments/catalog";
import { formatScore, type AssessmentItem, type DisplayScore } from "@/lib/assessments/view";
import { IMPORT_ACCEPT } from "@/lib/assessments/extract/detect";
import { ASSESSMENT_SAMPLE_TYPES, DEMO_SAMPLES, isDemo } from "@/lib/demo";
import { can, requirePermission } from "@/lib/permissions";
import { listAssessments } from "@/lib/services/assessments";
import { asOfToday, orNotFound, requirePageCtx, uuidParam } from "@/lib/server/page-session";

export const metadata: Metadata = { title: "Assessments" };

const score = (s: DisplayScore) => formatScore(s.kind, s.value, s.possible);
const signed = (n: number) => (n > 0 ? `+${n}` : String(n));

function Meta({ i }: { i: AssessmentItem }) {
  const parts = [
    i.moduleName,
    i.formName,
    i.respondentName ? `respondent: ${i.respondentName.toLowerCase()}` : null,
    i.administeredBy ? `by ${i.administeredBy}` : null,
    i.source === "vbmapp_import" ? "from the VB-MAPP workbook" : null,
    i.source === "import" ? "imported from a file" : null,
  ].filter(Boolean);
  return parts.length ? <span className="muted"> · {parts.join(" · ")}</span> : null;
}

export default async function AssessmentsPage({ params }: { params: Promise<{ id: string }> }) {
  const id = await uuidParam(params);
  const ctx = await requirePageCtx();
  requirePermission(ctx.role, "client:read");
  const catalog = assessmentCatalog();
  const { client, groups, pendingImports } = await orNotFound(() => listAssessments(ctx, id, catalog));
  const canWrite = can(ctx.role, "assessment:write");
  const canConfirm = can(ctx.role, "assessment:confirm");
  const base = `/api/clients/${id}/assessments`;

  return (
    <>
      <p>
        <Link href={`/clients/${id}`}>
          ← {client.firstName} {client.lastName}
        </Link>
      </p>
      <h1>Assessments</h1>
      <p className="page-sub">
        Every assessment for this client, newest first. Repeats of the same assessment are grouped so progress
        shows side by side. Only scores are stored, never report text.
      </p>
      {canWrite && (
        <div className="panel">
          <AddAssessment
            url={base}
            importUrl={`${base}/imports`}
            groups={addOptions(catalog, id, asOfToday())}
            accept={IMPORT_ACCEPT}
            demo={isDemo()}
            samples={DEMO_SAMPLES.assessments.map((name) => ({ name, type: ASSESSMENT_SAMPLE_TYPES[name] }))}
            testId="add-assessment"
          />
          {pendingImports.length > 0 && (
            <p data-testid="pending-imports">
              Imports waiting for review:{" "}
              {pendingImports.map((p, k) => (
                <span key={p.id}>
                  {k > 0 && " · "}
                  <Link href={`/assessments/imports/${p.id}`}>
                    {catalogType(catalog, p.typeKey)?.name ?? p.typeKey} ({p.filename})
                  </Link>
                </span>
              ))}
            </p>
          )}
        </div>
      )}
      {groups.length === 0 && <p className="muted">No assessments yet.</p>}
      {groups.map((g) => {
        const type = catalogType(catalog, g.typeKey);
        return (
          <div className="panel" key={g.key} data-testid="assessment-group">
            <h2 style={{ marginTop: 0 }}>
              {g.label}{" "}
              <span className="badge info">{GROUP_LABELS[(type?.group ?? "other") as AssessmentGroup]}</span>
            </h2>
            {g.items.map((i) => {
              const details = i.scores.filter((s) => !i.summary.some((x) => x.key === s.key));
              const draft = i.status === "draft";
              return (
                <div key={i.id} className="list-row" data-testid="assessment-row">
                  <div>
                    <span className={`badge ${draft ? "draft" : "ok"}`}>{draft ? "draft" : "confirmed"}</span>{" "}
                    {i.href ? (
                      <Link href={i.href}>
                        <strong>{i.administeredOn ?? "No valid date"}</strong>
                        {i.adminNumber ? ` (administration ${i.adminNumber})` : ""}
                      </Link>
                    ) : (
                      <strong>{i.administeredOn}</strong>
                    )}
                    <Meta i={i} />
                    <div data-testid="assessment-summary">
                      {i.summary.length ? (
                        i.summary.map((s) => `${s.name} ${score(s)}`).join(" · ")
                      ) : (
                        <span className="muted">No scores entered</span>
                      )}
                    </div>
                    {details.length > 0 && (
                      <details>
                        <summary className="muted">All scores ({i.scores.length})</summary>
                        <div className="table-wrap">
                          <table>
                            <tbody>
                              {i.scores.map((s) => (
                                <tr key={s.key}>
                                  <th style={s.parent ? { paddingLeft: 20, fontWeight: 400 } : undefined}>
                                    {s.name}
                                  </th>
                                  <td>{score(s)}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      </details>
                    )}
                    {i.notes && <div className="muted">{i.notes}</div>}
                  </div>
                  {i.source === "vbmapp_import" ? (
                    <RowMenu
                      name="VB-MAPP administration"
                      actions={[{ label: "Open grid", href: i.href! }]}
                    />
                  ) : (
                    canWrite &&
                    draft &&
                    type && (
                      <RowMenu
                        name="assessment"
                        testId="assessment-menu"
                        edit={{
                          url: `${base}/${i.id}`,
                          method: "PUT",
                          fields: assessmentFields(type, i.module),
                          extra: { typeKey: i.typeKey, module: i.module },
                          initial: editValues(catalog, i),
                          submitLabel: "Save draft",
                        }}
                        actions={
                          canConfirm
                            ? [
                                {
                                  label: "Confirm",
                                  request: {
                                    url: `${base}/${i.id}/confirm`,
                                    confirm:
                                      "Confirm these scores? Confirmed scores are locked and can be used in plans.",
                                  },
                                },
                              ]
                            : []
                        }
                        remove={{
                          url: `${base}/${i.id}`,
                          confirm: "Delete this draft assessment?",
                          label: "Delete",
                        }}
                      />
                    )
                  )}
                </div>
              );
            })}
            {g.progress && (
              <div className="table-wrap">
                <table data-testid="assessment-progress">
                  <thead>
                    <tr>
                      <th>Progress</th>
                      {g.progress.dates.map((d, k) => (
                        <th key={k}>{d ?? "no date"}</th>
                      ))}
                      <th>Change</th>
                    </tr>
                  </thead>
                  <tbody>
                    {g.progress.rows.map((r) => (
                      <tr key={r.key}>
                        <th>{r.name}</th>
                        {r.cells.map((c, k) => (
                          <td key={k}>{c ? formatScore(r.kind, c.value, c.possible) : "–"}</td>
                        ))}
                        <td>{r.change === null ? "–" : signed(r.change)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        );
      })}
    </>
  );
}
