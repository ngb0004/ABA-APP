import Link from "next/link";
import { ActionButton } from "@/components/actions";
import { RuleSource, Status } from "@/components/status";
import { toDay } from "@/lib/dates";
import { can } from "@/lib/permissions";
import { clientDetail } from "@/lib/services/clients";
import { asOfToday, requirePageCtx } from "@/lib/server/page-session";

export default async function ClientPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await requirePageCtx();
  const d = await clientDetail(ctx, id, asOfToday());
  const c = d.client;
  const pct = (n: number | null) => (n === null ? "n/a" : `${Math.round(n * 100)}%`);
  return (
    <>
      <h1>
        {c.firstName} {c.lastName} {c.isSynthetic && <span className="badge info">synthetic</span>}
      </h1>
      <div className="row" style={{ marginBottom: 12 }}>
        <Link className="btn" href={`/clients/${id}/intake`}>
          Intake
        </Link>
        <Link className="btn" href={`/clients/${id}/vbmapp`}>
          VB-MAPP
        </Link>
        <Link className="btn" href={`/clients/${id}/goals`}>
          Goals
        </Link>
      </div>

      {d.alerts.length > 0 && (
        <div className="panel">
          <h2 style={{ marginTop: 0 }}>Alerts</h2>
          {d.alerts.map((a, i) => (
            <div key={i} className={`alert ${a.level}`} data-testid="client-alert">
              {a.message}
            </div>
          ))}
        </div>
      )}

      <div className="grid2">
        <div className="panel">
          <h2 style={{ marginTop: 0 }}>Client</h2>
          <table>
            <tbody>
              <tr>
                <th>Date of birth</th>
                <td>
                  {toDay(c.dob)} (age {d.age})
                </td>
              </tr>
              <tr>
                <th>Service location</th>
                <td>
                  {(c.serviceAddress as { line1?: string; city?: string; state?: string }).line1},{" "}
                  {(c.serviceAddress as { city?: string }).city},{" "}
                  {(c.serviceAddress as { state?: string }).state}
                </td>
              </tr>
              <tr>
                <th>Diagnoses</th>
                <td>
                  {c.diagnoses.map((x) => (
                    <div key={x.id}>
                      {x.icd10Code} / DSM-5 {x.dsm5Code}: {x.dsm5Label}
                      {x.isPrimary ? " (primary)" : ""}
                    </div>
                  ))}
                </td>
              </tr>
              <tr>
                <th>Payors</th>
                <td>
                  {c.payors.map((p) => (
                    <div key={p.id}>
                      {p.payor.name} ({p.priority}) · Member ID {p.memberId}
                    </div>
                  ))}
                </td>
              </tr>
              <tr>
                <th>Guardians</th>
                <td>
                  {(c.guardians as { name: string; relationship: string; legalCustody: boolean }[]).map(
                    (g, i) => (
                      <div key={i}>
                        {g.name}, {g.relationship}
                        {g.legalCustody ? " (legal custody)" : ""}
                      </div>
                    ),
                  )}
                </td>
              </tr>
              {d.signers && (
                <tr>
                  <th>May sign</th>
                  <td>
                    {d.signers.signers.map((s) => s.name).join(", ") || "Nobody yet"}{" "}
                    <div className="muted">{d.signers.reason}</div>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        <div className="panel">
          <h2 style={{ marginTop: 0 }}>Staff safety summary</h2>
          {d.safety.length === 0 ? (
            <p className="muted">No safety flags from intake.</p>
          ) : (
            d.safety.map((s) => (
              <div key={s.fieldId} className="alert danger" data-testid="safety-flag">
                {s.label}
                {s.detail ? `: ${s.detail}` : ""}
              </div>
            ))
          )}
          <h3>Prior evaluations to upload</h3>
          {d.uploads.length === 0 ? (
            <p className="muted">None listed at intake.</p>
          ) : (
            <ul>
              {d.uploads.map((u, i) => (
                <li key={i}>
                  {u.label} <Status s={u.uploaded ? "ok" : "missing"} />
                </li>
              ))}
            </ul>
          )}
          <h3>Availability</h3>
          <p>
            {d.availability.available ?? "Not recorded"} h/week available;{" "}
            {d.availability.recommended ?? "n/a"} h/week recommended{" "}
            {d.availability.fits === false && <span className="badge warn">does not fit</span>}
          </p>
        </div>
      </div>

      {d.auth && (
        <div className="panel" id="authorization">
          <h2 style={{ marginTop: 0 }}>Authorization {d.auth.authNumber}</h2>
          <p>
            {d.auth.payor.name} · {toDay(d.auth.startDate)} to {toDay(d.auth.endDate)} · {d.auth.kind}
          </p>
          <h3>Utilization (delivered vs approved)</h3>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>CPT</th>
                  <th>Basis</th>
                  <th>Approved / week</th>
                  <th>Approved total</th>
                  <th>Delivered to date</th>
                  <th>Expected to date</th>
                  <th>% to date</th>
                  <th>Flag</th>
                </tr>
              </thead>
              <tbody>
                {d.utilization.map((u) => (
                  <tr key={u.cptCode}>
                    <td>{u.cptCode}</td>
                    <td>per {u.unitBasis}</td>
                    <td>{u.unitBasis === "auth" ? "" : u.approvedPerWeek}</td>
                    <td>{u.approvedTotal}</td>
                    <td>{u.deliveredToDate}</td>
                    <td>{u.expectedToDate}</td>
                    <td>{pct(u.pctToDate)}</td>
                    <td>{u.flag ? <span className="badge warn">{u.flag}-delivery</span> : ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <details>
            <summary>Weekly detail</summary>
            {d.utilization
              .filter((u) => u.weeks.length && u.unitBasis !== "auth")
              .map((u) => (
                <div key={u.cptCode} className="table-wrap">
                  <h3>{u.cptCode}</h3>
                  <table>
                    <thead>
                      <tr>
                        <th>Week</th>
                        <th>Delivered</th>
                        <th>Approved</th>
                        <th>%</th>
                        <th></th>
                      </tr>
                    </thead>
                    <tbody>
                      {u.weeks.map((w) => (
                        <tr key={w.weekStart}>
                          <td>{w.weekStart}</td>
                          <td>{w.delivered}</td>
                          <td>{w.approved}</td>
                          <td>{Math.round(w.pct * 100)}%</td>
                          <td>{w.flag && <span className="badge warn">{w.flag}</span>}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ))}
          </details>
          <h3>Supervision by month</h3>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Month</th>
                  <th>Direct h</th>
                  <th>Supervision h</th>
                  <th>Ratio</th>
                  <th>In-person supervision sessions</th>
                  <th>Per technician</th>
                </tr>
              </thead>
              <tbody>
                {d.supervision.map((m) => (
                  <tr key={m.month}>
                    <td>{m.month}</td>
                    <td>{m.directHours}</td>
                    <td>{m.supervisionHours}</td>
                    <td>{pct(m.ratio)}</td>
                    <td>{m.inPersonSupervisionSessions}</td>
                    <td>{m.perTechnician.map((t) => `${t.providerId}: ${pct(t.ratio)}`).join("; ")}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="muted">Payor thresholds are evaluated under Payor rules below.</p>
        </div>
      )}

      <div className="panel">
        <h2 style={{ marginTop: 0 }}>Payor rules</h2>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Status</th>
                <th>Rule</th>
                <th>Result</th>
              </tr>
            </thead>
            <tbody>
              {d.ruleResults.map((r) => (
                <tr key={r.rule.id}>
                  <td>
                    <Status s={r.status} />
                    {r.rawStatus !== r.status && <div className="muted">would {r.rawStatus}</div>}
                  </td>
                  <td>{r.rule.type.replace(/_/g, " ")}</td>
                  <td>
                    {r.message}
                    {r.evidence.length > 0 && (
                      <details>
                        <summary className="muted">Evidence</summary>
                        <ul>
                          {r.evidence.map((e, i) => (
                            <li key={i}>{e}</li>
                          ))}
                        </ul>
                      </details>
                    )}
                    <div>
                      <RuleSource r={r.rule} />
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="grid2">
        <div className="panel">
          <h2 style={{ marginTop: 0 }}>Next 60 days</h2>
          <ul>
            {d.events.map((e, i) => (
              <li key={i}>
                {e.date}: {e.label}
              </li>
            ))}
          </ul>
        </div>
        <div className="panel">
          <h2 style={{ marginTop: 0 }}>Attachments</h2>
          <ul>
            {c.attachments.map((a) => (
              <li key={a.id}>
                {a.title}{" "}
                <span className="muted">
                  ({a.kind}
                  {a.documentDate ? `, ${toDay(a.documentDate)}` : ""})
                  {a.caregiverSigned ? "" : " · not caregiver-signed"}
                </span>
              </li>
            ))}
          </ul>
        </div>
      </div>

      <div className="panel">
        <h2 style={{ marginTop: 0 }}>Treatment plans</h2>
        <ul>
          {c.plans.map((p) => (
            <li key={p.id}>
              <Link href={`/plans/${p.id}`}>{p.type === "reauth" ? "Reauthorization" : "Initial"} plan</Link>{" "}
              <span className="muted">
                created {toDay(p.createdAt)} · {p.status}
              </span>
            </li>
          ))}
        </ul>
        {can(ctx.role, "plan:create") && (
          <div className="row">
            <ActionButton
              url={`/api/clients/${id}/plans`}
              body={{ type: "initial" }}
              redirectKey="planId"
              redirectPrefix="/plans/"
              secondary
            >
              New initial plan
            </ActionButton>
            <ActionButton
              url={`/api/clients/${id}/plans`}
              body={{ type: "reauth" }}
              redirectKey="planId"
              redirectPrefix="/plans/"
              testId="new-reauth-plan"
            >
              New reauth plan
            </ActionButton>
          </div>
        )}
      </div>
    </>
  );
}
