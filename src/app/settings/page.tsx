import { ActionButton } from "@/components/actions";
import { FormToggle, RecordForm, type FieldSpec } from "@/components/record-form";
import { MEMBER_ROLES, practiceSettings } from "@/lib/services/records";
import { orgSettings } from "@/lib/services/clients";
import { requirePageCtx } from "@/lib/server/page-session";

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
  { name: "role", label: "Role", type: "select", options: MEMBER_ROLES },
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
          }}
        />
      </div>
      <div className="panel" data-testid="team">
        <h2 style={{ marginTop: 0 }}>Team</h2>
        <div className="table-wrap">
          <table>
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
                  <td>{m.name}</td>
                  <td>{m.email}</td>
                  <td>
                    {m.role}
                    {m.userId !== ctx.userId && (
                      <div className="row">
                        {MEMBER_ROLES.filter((r) => r !== m.role).map((r) => (
                          <ActionButton
                            key={r}
                            url={`/api/settings/members/${m.id}`}
                            method="PATCH"
                            body={{ role: r }}
                            secondary
                            confirm={`Change ${m.name}'s role to ${r}? They will be signed out.`}
                          >
                            Make {r}
                          </ActionButton>
                        ))}
                      </div>
                    )}
                  </td>
                  <td>{m.mfaEnabled ? "set up" : "not yet"}</td>
                  <td>
                    {m.userId !== ctx.userId && (
                      <ActionButton
                        url={`/api/settings/members/${m.id}`}
                        method="DELETE"
                        secondary
                        confirm={`Remove ${m.name} from the practice?`}
                      >
                        Remove
                      </ActionButton>
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
