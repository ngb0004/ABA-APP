import type { Metadata } from "next";
import Link from "next/link";
import { clientFields } from "@/components/client-fields";
import { label, labeled } from "@/components/labels";
import { planTypeLine } from "@/components/payor-display";
import { FormToggle, RecordForm, type FieldSpec } from "@/components/record-form";
import { RowMenu } from "@/components/row-menu";
import { toDay } from "@/lib/dates";
import { formatClock } from "@/lib/time-format";
import { isDemo } from "@/lib/demo";
import {
  BENEFITS_CHECK_METHODS,
  METHOD_LABELS,
  PLAN_FUNDING,
  PLAN_FUNDING_LABELS,
  YES_NO_UNKNOWN,
  type BenefitsCheckMethod,
} from "@/lib/payors/benefits";
import { PLAN_TYPES, PLAN_TYPE_LABELS, US_STATES } from "@/lib/payors/types";
import { can } from "@/lib/permissions";
import {
  ATTACHMENT_KINDS,
  CPT_CODES,
  DEFICIT_AREAS,
  SESSION_ROLES,
  clientRecords,
} from "@/lib/services/records";
import { asOfToday, orNotFound, requirePageCtx, uuidParam } from "@/lib/server/page-session";

export const metadata: Metadata = { title: "Records" };

const yesNo = (b: boolean) => (b ? "yes" : "no");

export default async function RecordsPage({ params }: { params: Promise<{ id: string }> }) {
  const id = await uuidParam(params);
  const ctx = await requirePageCtx();
  const { client: c, sessions, payors } = await orNotFound(() => clientRecords(ctx, id));
  const canClient = can(ctx.role, "client:write");
  const canIns = can(ctx.role, "insurance:manage");
  const canDocs = can(ctx.role, "document:manage");
  const canData = can(ctx.role, "data:enter");
  // On the demo the identity is generated: only the IEP flag and payor events can change.
  const demo = isDemo();
  const payorOptions = payors.map((p) => ({ value: p.id, label: p.name }));
  const base = `/api/clients/${id}`;
  const today = asOfToday();
  const addr = c.serviceAddress as { line1?: string; city?: string; state?: string; zip?: string };

  const payorFields: FieldSpec[] = [
    { name: "payorId", label: "Payor", type: "select", options: payorOptions },
    { name: "priority", label: "Priority", type: "select", options: labeled(["primary", "secondary"]) },
    { name: "memberId", label: "Member ID", placeholder: "SYN-…", help: "Synthetic only: starts with SYN-" },
    { name: "planName", label: "Plan name", optional: true },
    {
      name: "planType",
      label: "Plan type",
      type: "select",
      optional: true,
      // Blank stays "not recorded": every rule applies, with a warning to confirm it.
      options: PLAN_TYPES.filter((t) => t !== "unknown").map((t) => ({
        value: t,
        label: PLAN_TYPE_LABELS[t],
      })),
      help: "From the benefits check. Self-funded employer plans are exempt from state autism mandates.",
    },
    {
      name: "planState",
      label: "State plan was issued in",
      type: "select",
      optional: true,
      options: US_STATES,
      help: "Leave blank if it is the client's service state",
    },
    { name: "secondaryDocsSigned", label: "Secondary insurance documents signed", type: "checkbox" },
  ];
  const yesNoUnknown = YES_NO_UNKNOWN.map((v) => ({ value: v, label: label(v) }));
  const checkFields: FieldSpec[] = [
    { name: "checkedOn", label: "Date checked", type: "date" },
    {
      name: "method",
      label: "How",
      type: "select",
      options: BENEFITS_CHECK_METHODS.map((m) => ({ value: m, label: label(METHOD_LABELS[m]) })),
    },
    {
      name: "referenceNumber",
      label: "Reference number",
      optional: true,
      placeholder: "SYN-…",
      help: "The call or portal reference. Synthetic only: starts with SYN-",
    },
    { name: "abaCovered", label: "ABA covered", type: "select", options: yesNoUnknown },
    {
      name: "priorAuthRequired",
      label: "Prior authorization required",
      type: "select",
      options: yesNoUnknown,
    },
    {
      name: "planFunding",
      label: "Plan funding",
      type: "select",
      options: PLAN_FUNDING.map((f) => ({ value: f, label: PLAN_FUNDING_LABELS[f] })),
      help: "Commercial plans: fully insured plans follow state autism mandates; self-funded employer plans do not",
    },
    { name: "ageLimitYears", label: "Age limit (years)", type: "number", optional: true },
    { name: "visitOrHourLimits", label: "Visit or hour limits", optional: true },
    { name: "notes", label: "Notes", optional: true },
  ];
  const dxFields: FieldSpec[] = [
    { name: "icd10Code", label: "ICD-10 code", placeholder: "F84.0" },
    { name: "dsm5Code", label: "DSM-5 code", placeholder: "299.00" },
    { name: "dsm5Label", label: "Diagnosis" },
    { name: "severity", label: "Severity / level of support", optional: true },
    { name: "evaluationDate", label: "Evaluation date", type: "date", optional: true },
    { name: "isPrimary", label: "Primary diagnosis", type: "checkbox" },
    { name: "deficitAreas", label: "Deficit areas documented", type: "checkboxes", options: DEFICIT_AREAS },
  ];
  const authFields: FieldSpec[] = [
    { name: "payorId", label: "Payor", type: "select", options: payorOptions },
    { name: "authNumber", label: "Authorization number", placeholder: "SYN-AUTH-…" },
    { name: "kind", label: "Kind", type: "select", options: labeled(["initial", "reauth"]) },
    { name: "startDate", label: "Start", type: "date" },
    { name: "endDate", label: "End", type: "date" },
    { name: "recommendedHoursPerWeek", label: "Recommended hours per week", type: "number", optional: true },
    {
      name: "units",
      label: "Approved units",
      type: "list",
      addLabel: "Add code",
      fields: [
        { name: "cptCode", label: "CPT code", type: "select", options: CPT_CODES },
        { name: "approvedUnits", label: "Units", type: "number" },
        { name: "unitBasis", label: "Per", type: "select", options: labeled(["week", "month", "auth"]) },
      ],
    },
  ];
  const attFields: FieldSpec[] = [
    { name: "kind", label: "Kind", type: "select", options: labeled(ATTACHMENT_KINDS) },
    { name: "title", label: "Title" },
    { name: "documentDate", label: "Document date", type: "date", optional: true },
    { name: "caregiverSigned", label: "Caregiver signed", type: "checkbox" },
  ];
  const sessionFields: FieldSpec[] = [
    {
      name: "authorizationId",
      label: "Authorization",
      type: "select",
      options: c.authorizations.map((a) => ({
        value: a.id,
        label: `${a.authNumber} (${toDay(a.startDate)} to ${toDay(a.endDate)})`,
      })),
    },
    { name: "cptCode", label: "CPT code", type: "select", options: CPT_CODES },
    { name: "date", label: "Date", type: "date" },
    { name: "startMinute", label: "Start time", type: "time" },
    { name: "units", label: "Units (15 min)", type: "number" },
    { name: "providerRole", label: "Provider role", type: "select", options: SESSION_ROLES },
    { name: "providerId", label: "Staff code", placeholder: "RBT-A", help: "A short code, never a name" },
    { name: "inPerson", label: "In person", type: "checkbox" },
  ];

  return (
    <>
      <p>
        <Link href={`/clients/${id}`}>
          ← {c.firstName} {c.lastName}
        </Link>
      </p>
      <h1>Records</h1>
      <p className="alert warn">
        v1.0 holds fictional clients only. Member and authorization numbers must start with SYN-, staff are
        entered as codes, and attachments are recorded by title and date (no files).
      </p>

      <div className="panel" data-testid="records-client">
        <h2 style={{ marginTop: 0 }}>Client details</h2>
        <p>
          {c.firstName} {c.lastName}
          {c.preferredName ? ` ("${c.preferredName}")` : ""} · born {toDay(c.dob)} · {addr.line1}, {addr.city}
          , {addr.state} {addr.zip} · IEP {yesNo(c.hasIep)}
        </p>
        {canClient && (
          <FormToggle label="Edit details" testId="edit-client" secondary>
            <RecordForm
              url={base}
              method="PATCH"
              fields={
                demo ? clientFields.filter((f) => f.name === "hasIep" || f.name === "events") : clientFields
              }
              submitLabel="Save details"
              testId="client-form"
              initial={
                demo
                  ? { hasIep: c.hasIep, events: c.events }
                  : {
                      firstName: c.firstName,
                      lastName: c.lastName,
                      preferredName: c.preferredName ?? "",
                      dob: toDay(c.dob),
                      sex: c.sex ?? "",
                      serviceAddress: { line1: "", city: "", state: "", zip: "", ...addr },
                      hasIep: c.hasIep,
                      events: c.events,
                      guardians: c.guardians,
                    }
              }
            />
          </FormToggle>
        )}
      </div>

      <div className="panel" data-testid="records-insurance">
        <h2 style={{ marginTop: 0 }}>Insurance</h2>
        {c.payors.length > 0 && (
          <p className="muted">
            <Link href={`/clients/${id}/requirements`} data-testid="requirements-link-records">
              What each payor requires for this client
            </Link>
          </p>
        )}
        <table>
          <tbody>
            {c.payors.map((p) => (
              <tr key={p.id}>
                <td>
                  {p.payor.name} ({label(p.priority).toLowerCase()}) · {p.memberId}
                  {p.planName ? ` · ${p.planName}` : ""}
                  <div className="muted" data-testid="plan-type">
                    {planTypeLine(p.planType, p.planState)}
                  </div>
                  <div className="muted" data-testid="benefits-checked">
                    {p.benefitsChecks[0]
                      ? `Benefits last checked ${toDay(p.benefitsChecks[0].checkedOn)} (${
                          METHOD_LABELS[p.benefitsChecks[0].method as BenefitsCheckMethod] ??
                          p.benefitsChecks[0].method
                        })`
                      : "Benefits not checked yet"}
                  </div>
                </td>
                <td>
                  {canIns && (
                    <RowMenu
                      name="insurance"
                      actions={[
                        {
                          label: "Record benefits check",
                          form: {
                            url: `${base}/payors/${p.id}/benefits-checks`,
                            fields: checkFields,
                            submitLabel: "Save benefits check",
                            testId: "benefits-check-form",
                            initial: {
                              checkedOn: today,
                              method: "phone",
                              abaCovered: "unknown",
                              priorAuthRequired: "unknown",
                              planFunding: "unknown",
                            },
                          },
                        },
                      ]}
                      edit={{
                        url: `${base}/payors/${p.id}`,
                        method: "PUT",
                        fields: payorFields,
                        submitLabel: "Save",
                        initial: {
                          payorId: p.payorId,
                          priority: p.priority,
                          memberId: p.memberId,
                          planName: p.planName ?? "",
                          planType: p.planType === "unknown" ? "" : p.planType,
                          planState: p.planState ?? "",
                          secondaryDocsSigned: p.secondaryDocsSigned,
                        },
                      }}
                      remove={{
                        url: `${base}/payors/${p.id}`,
                        confirm: "Remove this insurance?",
                        label: "Remove",
                      }}
                    />
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {!c.payors.length && <p className="muted">No insurance on file.</p>}
        {canIns && (
          <FormToggle label="Add insurance" testId="add-insurance">
            <RecordForm
              url={`${base}/payors`}
              fields={payorFields}
              submitLabel="Add insurance"
              testId="insurance-form"
              initial={{ priority: c.payors.length ? "secondary" : "primary" }}
            />
          </FormToggle>
        )}
      </div>

      <div className="panel" data-testid="records-diagnoses">
        <h2 style={{ marginTop: 0 }}>Diagnoses</h2>
        <table>
          <tbody>
            {c.diagnoses.map((d) => (
              <tr key={d.id}>
                <td>
                  {d.icd10Code} / DSM-5 {d.dsm5Code}: {d.dsm5Label}
                  {d.isPrimary ? " (primary)" : ""}
                  {d.evaluationDate ? ` · evaluated ${toDay(d.evaluationDate)}` : ""}
                  <div className="muted">{d.deficitAreas.map((x) => x.replace(/_/g, " ")).join(", ")}</div>
                </td>
                <td>
                  {canClient && (
                    <RowMenu
                      name="diagnosis"
                      edit={{
                        url: `${base}/diagnoses/${d.id}`,
                        method: "PUT",
                        fields: dxFields,
                        submitLabel: "Save",
                        initial: {
                          icd10Code: d.icd10Code,
                          dsm5Code: d.dsm5Code,
                          dsm5Label: d.dsm5Label,
                          severity: d.severity ?? "",
                          evaluationDate: d.evaluationDate ? toDay(d.evaluationDate) : "",
                          isPrimary: d.isPrimary,
                          deficitAreas: d.deficitAreas,
                        },
                      }}
                      remove={{
                        url: `${base}/diagnoses/${d.id}`,
                        confirm: "Remove this diagnosis?",
                        label: "Remove",
                      }}
                    />
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {!c.diagnoses.length && <p className="muted">No diagnoses on file.</p>}
        {canClient && (
          <FormToggle label="Add diagnosis" testId="add-diagnosis">
            <RecordForm
              url={`${base}/diagnoses`}
              fields={dxFields}
              submitLabel="Add diagnosis"
              testId="diagnosis-form"
              initial={{ isPrimary: !c.diagnoses.length }}
            />
          </FormToggle>
        )}
      </div>

      <div className="panel" data-testid="records-authorizations">
        <h2 style={{ marginTop: 0 }}>Authorizations</h2>
        {c.authorizations.map((a) => (
          <div key={a.id} className="list-row">
            <div>
              <strong>{a.authNumber}</strong> · {a.payor.name} · {label(a.kind)} · {toDay(a.startDate)} to{" "}
              {toDay(a.endDate)}
              <div className="muted">
                {a.units.map((u) => `${u.cptCode}: ${u.approvedUnits} per ${u.unitBasis}`).join(" · ") ||
                  "No units"}
              </div>
            </div>
            {canIns && (
              <RowMenu
                name="authorization"
                edit={{
                  url: `${base}/authorizations/${a.id}`,
                  method: "PUT",
                  fields: authFields,
                  submitLabel: "Save",
                  initial: {
                    payorId: a.payorId,
                    authNumber: a.authNumber,
                    kind: a.kind,
                    startDate: toDay(a.startDate),
                    endDate: toDay(a.endDate),
                    recommendedHoursPerWeek: a.recommendedHoursPerWeek ?? "",
                    units: a.units.map((u) => ({
                      cptCode: u.cptCode,
                      approvedUnits: u.approvedUnits,
                      unitBasis: u.unitBasis,
                    })),
                  },
                }}
                remove={{
                  url: `${base}/authorizations/${a.id}`,
                  confirm: "Delete this authorization?",
                  label: "Delete",
                }}
              />
            )}
          </div>
        ))}
        {!c.authorizations.length && <p className="muted">No authorizations on file.</p>}
        {canIns && (
          <FormToggle label="Add authorization" testId="add-authorization">
            <RecordForm
              url={`${base}/authorizations`}
              fields={authFields}
              submitLabel="Add authorization"
              testId="authorization-form"
              initial={{ kind: "initial" }}
            />
          </FormToggle>
        )}
      </div>

      <div className="panel" data-testid="records-attachments">
        <h2 style={{ marginTop: 0 }}>Attachments</h2>
        <table>
          <tbody>
            {c.attachments.map((a) => (
              <tr key={a.id}>
                <td>
                  {a.title}{" "}
                  <span className="muted">
                    ({label(a.kind)}
                    {a.documentDate ? `, ${toDay(a.documentDate)}` : ""}
                    {a.caregiverSigned ? ", caregiver signed" : ""})
                  </span>
                </td>
                <td>
                  {canDocs && (
                    <RowMenu
                      name="attachment"
                      edit={{
                        url: `${base}/attachments/${a.id}`,
                        method: "PUT",
                        fields: attFields,
                        submitLabel: "Save",
                        initial: {
                          kind: a.kind,
                          title: a.title,
                          documentDate: a.documentDate ? toDay(a.documentDate) : "",
                          caregiverSigned: a.caregiverSigned,
                        },
                      }}
                      remove={{
                        url: `${base}/attachments/${a.id}`,
                        confirm: "Remove this attachment?",
                        label: "Remove",
                      }}
                    />
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {!c.attachments.length && <p className="muted">No attachments recorded.</p>}
        {canDocs && (
          <FormToggle label="Record an attachment" testId="add-attachment">
            <RecordForm
              url={`${base}/attachments`}
              fields={attFields}
              submitLabel="Record attachment"
              testId="attachment-form"
            />
          </FormToggle>
        )}
      </div>

      <div className="panel" data-testid="records-sessions">
        <h2 style={{ marginTop: 0 }}>Sessions</h2>
        {canData && c.authorizations.length > 0 && (
          <FormToggle label="Add a session" testId="add-session">
            <RecordForm
              url={`${base}/sessions`}
              fields={sessionFields}
              submitLabel="Add session"
              testId="session-form"
              initial={{
                authorizationId: c.authorizations[0]!.id,
                startMinute: 540,
                inPerson: true,
                providerRole: "RBT",
              }}
            />
          </FormToggle>
        )}
        {!c.authorizations.length && <p className="muted">Add an authorization before recording sessions.</p>}
        {c.authorizations.length > 0 && !sessions.length && <p className="muted">No sessions yet.</p>}
        {sessions.length > 0 && (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Code</th>
                  <th>Start</th>
                  <th>Units</th>
                  <th>Staff</th>
                  <th>Where</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {sessions.map((s) => (
                  <tr key={s.id}>
                    <td>{toDay(s.date)}</td>
                    <td>{s.cptCode}</td>
                    <td>{formatClock(s.startMinute)}</td>
                    <td>{s.units}</td>
                    <td>
                      {s.providerRole} {s.providerId ?? ""}
                    </td>
                    <td>{s.inPerson ? "in person" : "remote"}</td>
                    <td>
                      {canData && (
                        <RowMenu
                          name={`session on ${toDay(s.date)}`}
                          remove={{
                            url: `${base}/sessions/${s.id}`,
                            confirm: "Delete this session?",
                            label: "Delete",
                          }}
                        />
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {sessions.length === 60 && <p className="muted">Showing the 60 most recent sessions.</p>}
      </div>
    </>
  );
}
