import Link from "next/link";
import { IntakeForm } from "@/components/intake-form";
import { ageYears, toDay } from "@/lib/dates";
import { applicableFields } from "@/lib/intake/schema";
import { can } from "@/lib/permissions";
import { clientDetail } from "@/lib/services/clients";
import { asOfToday, requirePageCtx } from "@/lib/server/page-session";

export default async function IntakePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await requirePageCtx();
  const asOf = asOfToday();
  const d = await clientDetail(ctx, id, asOf);
  const age = ageYears(toDay(d.client.dob), asOf);
  // Restricted fields are visible to the BCBA only.
  const fields = applicableFields(age).filter(
    (f) => f.sensitivity !== "restricted" || can(ctx.role, "client:read_restricted"),
  );
  return (
    <>
      <p>
        <Link href={`/clients/${id}`}>
          ← {d.client.firstName} {d.client.lastName}
        </Link>
      </p>
      <h1>Parent intake</h1>
      <p className="muted">
        Status: {d.intake?.status ?? "not started"}. Entered by the BCBA from the completed form. Every field
        must be answered or marked none / not applicable before submission. Age-conditional fields appear at
        the applicable age (client is {age}).
      </p>
      {can(ctx.role, "intake:write") ? (
        <IntakeForm clientId={id} fields={fields} initial={d.answers} canSubmit />
      ) : (
        <p className="alert warn">Your role can view the client but cannot edit the intake.</p>
      )}
    </>
  );
}
