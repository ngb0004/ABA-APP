import type { Metadata } from "next";
import { RecordForm, type FieldSpec } from "@/components/record-form";
import { isDemo } from "@/lib/demo";
import { requirePermission } from "@/lib/permissions";
import { requirePageCtx } from "@/lib/server/page-session";
import { clientFields } from "@/components/client-fields";

const fields: FieldSpec[] = [
  ...clientFields,
  {
    name: "fictional",
    label: "This client is fictional (v1.0 holds synthetic data only; never enter a real person)",
    type: "checkbox",
  },
];

// The demo is not HIPAA hosting: it makes up the name, birth date, and address itself.
const demoFields: FieldSpec[] = [
  { name: "ageYears", label: "Age in years", type: "number" },
  { name: "hasIep", label: "Has an IEP or IFSP", type: "checkbox" },
];

export const metadata: Metadata = { title: "New client" };

export default async function NewClientPage() {
  const ctx = await requirePageCtx();
  requirePermission(ctx.role, "client:write");
  if (isDemo())
    return (
      <>
        <h1>New fictional client</h1>
        <p className="alert warn">
          On the demo site the app makes up the client&apos;s name, birth date, address, and guardian, so no
          real person&apos;s details can be entered. Add insurance, diagnoses, authorizations, sessions, and
          goals next.
        </p>
        <div className="panel">
          <RecordForm
            url="/api/clients"
            fields={demoFields}
            submitLabel="Create fictional client"
            testId="new-client-form"
            initial={{ ageYears: 5 }}
            redirectKey="id"
            redirectPrefix="/clients/"
          />
        </div>
      </>
    );
  return (
    <>
      <h1>New client</h1>
      <p className="alert warn">
        Fictional clients only until the HIPAA deployment. Use made-up names, dates, and addresses.
      </p>
      <div className="panel">
        <RecordForm
          url="/api/clients"
          fields={fields}
          submitLabel="Create client"
          testId="new-client-form"
          initial={{ serviceAddress: { state: "GA" } }}
          redirectKey="id"
          redirectPrefix="/clients/"
        />
      </div>
    </>
  );
}
