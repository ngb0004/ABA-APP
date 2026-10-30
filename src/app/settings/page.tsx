import type { Metadata } from "next";
import { RoleSelect, RowMenu } from "@/components/row-menu";
import { label, labeled } from "@/components/labels";
import { FormToggle, RecordForm, type FieldSpec } from "@/components/record-form";
import { MEMBER_ROLES, practiceSettings } from "@/lib/services/records";
import { orgSettings } from "@/lib/services/clients";
import { requirePageCtx } from "@/lib/server/page-session";
import { STATE_NAMES, US_STATES } from "@/lib/payors/types";

export const metadata: Metadata = { title: "Practice settings" };

const settingsFields: FieldSpec[] = [
  { name: "name", label: "Practice name" },
  { name: "npi", label: "NPI", optional: true, placeholder: "SYN-NPI-…" },
  { name: "taxId", label: "Tax ID", optional: true },
  {
    name: "reauthLeadDays",
    label: "Submit reauths this many days before the authorization ends",
    type: "number",
  },
  {
    name: "reassessmentLeadDays",
    label: "Reassess this many days before the authorization ends",
    type: "number",
  },
  {
    name: "statesServed",
    label: "States we serve (the Payor rules page shows these first)",
    type: "multiselect",
    options: US_STATES.map((s) => ({ value: s, label: `${STATE_NAMES[s]} (${s})` })),
    help: "With none chosen, the Payor rules page shows only payors that apply in every state.",
  },
  {
    name: "offices",
    label: "Offices (the service state's office address goes on payor forms)",
    type: "list",
    addLabel: "Add office",
    fields: [
      { name: "state", label: "State", placeholder: "GA" },
      { name: "address", label: "Address" },
    ],
  },
];

const memberFields: FieldSpec[] = [
  { name: "name", label: "Name" },
  { name: "email", label: "Email", type: "email" },
  { name: "role", label: "Role", type: "select", options: labeled(MEMBER_ROLES) },
  {
    name: "password",
    label: "Temporary password",
    type: "password",
    help: "At least 12 characters. They set up their authenticator app at first sign-in.",
  },
];

export default async function SettingsPage() {
  const ctx = await requirePageCtx();
  const { org, members } = await practiceSettings(ctx);
  const s = orgSettings(org.settings);
  const raw = org.settings as { npi?: string; taxId?: string };
  return (
    <>
      <h1>Practice settings</h1>
      <div className="panel">
        <h2 style={{ marginTop: 0 }}>Practice</h2>
        <RecordForm
          url="/api/settings"
          method="PUT"
          fields={settingsFields}
          submitLabel="Save settings"
          testId="settings-form"
          initial={{
            name: org.name,
            npi: raw.npi ?? "",
            taxId: raw.taxId ?? "",
            reauthLeadDays: s.reauthLeadDays,
            reassessmentLeadDays: s.reassessmentLeadDays,
            offices: s.offices,
            statesServed: s.statesServed,
          }}
        />
      </div>
      <div className="panel" data-testid="team">
        <h2 style={{ marginTop: 0 }}>Team</h2>
        <div className="table-wrap">
          <table className="stack">
            <thead>
              <tr>
                <th>Name</th>
                <th>Email</th>
                <th>Role</th>
                <th>Authenticator</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {members.map((m) => (
                <tr key={m.id} data-member={m.email}>
                  <td data-label="Name">{m.name}</td>
                  <td data-label="Email">{m.email}</td>
                  <td data-label="Role">
                    {m.userId !== ctx.userId && m.role !== "PARENT" ? (
                      <RoleSelect
                        url={`/api/settings/members/${m.id}`}
                        name={m.name}
                        role={m.role}
                        options={MEMBER_ROLES.map((r) => ({ value: r, label: label(r) }))}
                      />
                    ) : (
                      label(m.role)
                    )}
                  </td>
                  <td data-label="Authenticator">{m.mfaEnabled ? "set up" : "not yet"}</td>
                  <td data-label="">
                    {m.userId !== ctx.userId && (
                      <RowMenu
                        name={m.name}
                        remove={{
                          url: `/api/settings/members/${m.id}`,
                          label: "Remove from practice",
                          confirm: `Remove ${m.name} from the practice?`,
                        }}
                      />
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <FormToggle label="Add a team member" testId="add-member">
          <RecordForm
            url="/api/settings/members"
            fields={memberFields}
            submitLabel="Add member"
            testId="member-form"
          />
        </FormToggle>
      </div>
    </>
  );
}
