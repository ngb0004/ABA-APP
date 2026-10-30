import type { Metadata } from "next";
import Link from "next/link";
import { label } from "@/components/labels";
import {
  paramEntries,
  plural,
  REQUIREMENT_STATUS_LABELS,
  RULE_TYPE_LABELS,
} from "@/components/payor-display";
import { RuleSource } from "@/components/status";
import {
  METHOD_LABELS,
  PLAN_FUNDING_LABELS,
  type BenefitsCheckMethod,
  type PlanFunding,
} from "@/lib/payors/benefits";
import type { RequirementStatus } from "@/lib/payors/categories";
import {
  LINE_OF_BUSINESS_LABELS,
  PLAN_TYPE_LABELS,
  type LineOfBusiness,
  type RuleType,
} from "@/lib/payors/types";
import { clientRequirements } from "@/lib/services/requirements";
import { asOfToday, orNotFound, requirePageCtx, uuidParam } from "@/lib/server/page-session";

export const metadata: Metadata = { title: "Payor requirements" };

const STATUS_CLASS: Record<RequirementStatus, string> = {
  met: "pass",
  missing: "missing",
  manual: "warn",
  "n/a": "na",
};

export default async function RequirementsPage({ params }: { params: Promise<{ id: string }> }) {
  const id = await uuidParam(params);
  const ctx = await requirePageCtx();
  const d = await orNotFound(() => clientRequirements(ctx, id, asOfToday()));

  return (
    <>
      <p>
        <Link href={`/clients/${id}`}>
          ← {d.client.firstName} {d.client.lastName}
        </Link>
      </p>
      <h1>Payor requirements</h1>
      <p className="muted">
        What each of this client&apos;s insurers requires, for this client&apos;s payor, plan state, and plan
        type, and where each requirement stands today. Unverified rules are reminders: they only ever warn. To
        change the insurance or record a benefits check, use the ⋯ menu on{" "}
        <Link href={`/clients/${id}/records`}>Records</Link>.
      </p>

      {!d.insurances.length && (
        <p className="alert warn">No insurance on file. Add the client&apos;s insurance on Records.</p>
      )}

      {d.insurances.map((ins) => (
        <section className="panel" key={ins.id} data-testid="requirements-insurance">
          <h2 style={{ marginTop: 0 }}>
            {ins.payor.name} <span className="muted">({label(ins.priority).toLowerCase()})</span>
          </h2>
          <table>
            <tbody>
              <tr>
                <th>Payor</th>
                <td>
                  {ins.payor.name}{" "}
                  <span className="badge info">
                    {LINE_OF_BUSINESS_LABELS[ins.payor.lineOfBusiness as LineOfBusiness] ??
                      ins.payor.lineOfBusiness}
                  </span>
                  {ins.planName ? <span className="muted"> · {ins.planName}</span> : null}
                </td>
              </tr>
              <tr>
                <th>Plan type</th>
                <td data-testid="requirements-plan-type">{PLAN_TYPE_LABELS[ins.planType] ?? ins.planType}</td>
              </tr>
              <tr>
                <th>Plan state</th>
                <td>
                  {ins.planState || "Not known"}{" "}
                  <span className="muted">
                    {ins.planStateRecorded ? "(recorded on the insurance)" : "(the client's service state)"}
                  </span>
                </td>
              </tr>
            </tbody>
          </table>
          {ins.scope.map((f) => (
            <div key={f.id} className="alert warn" data-testid="requirements-scope">
              {f.message}
            </div>
          ))}
          {ins.fundingConflict && (
            <div className="alert warn">
              The latest benefits check disagrees with the plan type on record. Check the plan type on
              Records.
            </div>
          )}

          <h3>Benefits checks</h3>
          {!ins.checks.length ? (
            <p className="muted" data-testid="benefits-history">
              Benefits not checked yet. Record one from the insurance&apos;s ⋯ menu on Records.
            </p>
          ) : (
            <div className="table-wrap">
              <table data-testid="benefits-history">
                <thead>
                  <tr>
                    <th>Date</th>
                    <th>How</th>
                    <th>ABA covered</th>
                    <th>Prior auth</th>
                    <th>Funding</th>
                    <th>Limits and notes</th>
                  </tr>
                </thead>
                <tbody>
                  {ins.checks.map((c) => (
                    <tr key={c.id}>
                      <td>
                        {c.checkedOn}
                        {c.checkedBy && <div className="muted">{c.checkedBy}</div>}
                      </td>
                      <td>
                        {METHOD_LABELS[c.method as BenefitsCheckMethod] ?? c.method}
                        {c.referenceNumber && <div className="muted">Ref. {c.referenceNumber}</div>}
                      </td>
                      <td>{label(c.abaCovered)}</td>
                      <td>{label(c.priorAuthRequired)}</td>
                      <td>{PLAN_FUNDING_LABELS[c.planFunding as PlanFunding] ?? c.planFunding}</td>
                      <td>
                        {c.ageLimitYears !== null && <div>Covered through age {c.ageLimitYears}</div>}
                        {c.visitOrHourLimits && <div>{c.visitOrHourLimits}</div>}
                        {c.notes && <div className="muted">{c.notes}</div>}
                        {c.ageLimitYears === null && !c.visitOrHourLimits && !c.notes && (
                          <span className="muted">None recorded</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {!ins.groups.length && <p className="muted">No rules on file for this payor yet.</p>}
          {ins.groups.map((g) => (
            <div key={g.key} data-testid={`requirements-group-${g.key}`}>
              <h3>{g.label}</h3>
              <div className="table-wrap">
                <table className="rules-table">
                  <colgroup>
                    <col className="type" />
                    <col className="params" />
                    <col />
                  </colgroup>
                  <thead>
                    <tr>
                      <th>Requirement</th>
                      <th>For this client</th>
                      <th>Source and status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {g.items.map((r) => {
                      const entries = paramEntries(r.rule.params);
                      return (
                        <tr key={r.rule.id} data-rule={r.rule.id}>
                          <td>
                            {RULE_TYPE_LABELS[r.rule.type as RuleType] ?? r.rule.type.replace(/_/g, " ")}
                            {entries.length > 0 && (
                              <dl className="params-list">
                                {entries.map(([k, v]) => (
                                  <div key={k}>
                                    <dt>{k}:</dt> <dd>{v}</dd>
                                  </div>
                                ))}
                              </dl>
                            )}
                            {r.rule.notes && <div className="muted">{r.rule.notes}</div>}
                          </td>
                          <td>
                            <span
                              className={`badge ${STATUS_CLASS[r.status]}`}
                              data-testid="requirement-status"
                            >
                              {REQUIREMENT_STATUS_LABELS[r.status]}
                            </span>
                            <div>{r.message}</div>
                            {r.evidence.length > 0 && (
                              <details>
                                <summary className="muted">Details</summary>
                                <ul>
                                  {r.evidence.map((e, i) => (
                                    <li key={i}>{e}</li>
                                  ))}
                                </ul>
                              </details>
                            )}
                          </td>
                          <td>
                            <RuleSource r={r.rule} showReasons />
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          ))}
          {ins.otherPlanTypeRules > 0 && (
            <p className="muted">
              {plural(ins.otherPlanTypeRules, "rule")} for other plan types{" "}
              {ins.otherPlanTypeRules === 1 ? "is" : "are"} not shown.
            </p>
          )}
        </section>
      ))}

      <section className="panel" data-testid="requirements-letters">
        <h2 style={{ marginTop: 0 }}>Requirements from this client&apos;s letters</h2>
        {!d.letters.length && (
          <p className="muted">
            No requirements from confirmed payor letters. Upload and confirm a letter on a plan&apos;s packet
            page.
          </p>
        )}
        {d.letters.map((l) => (
          <div key={l.id}>
            <h3>
              Letter received {l.date}
              {l.classification ? <span className="muted"> · {label(l.classification)}</span> : null}
            </h3>
            <ul>
              {l.requirements.map((req, i) => (
                <li key={i}>{req}</li>
              ))}
            </ul>
          </div>
        ))}
        {d.unconfirmedLetters > 0 && (
          <p className="muted">
            {plural(d.unconfirmedLetters, "letter")} not confirmed yet: confirm on the packet page to list its
            requirements here.
          </p>
        )}
      </section>
      {d.removedInsuranceChecks > 0 && (
        <p className="muted">
          {plural(d.removedInsuranceChecks, "benefits check")} from insurance since removed are kept in the
          record.
        </p>
      )}
    </>
  );
}
