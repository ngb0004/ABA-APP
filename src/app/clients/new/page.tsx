import { RecordForm, type FieldSpec } from "@/components/record-form";
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

export default async function NewClientPage() {
  const ctx = await requirePageCtx();
  requirePermission(ctx.role, "client:write");
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
