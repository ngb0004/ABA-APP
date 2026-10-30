import type { Metadata } from "next";
import Link from "next/link";
import { IntakeForm } from "@/components/intake-form";
import { ageYears, toDay } from "@/lib/dates";
import { applicableFields } from "@/lib/intake/schema";
import { can } from "@/lib/permissions";
import { clientDetail } from "@/lib/services/clients";
import { asOfToday, orNotFound, requirePageCtx, uuidParam } from "@/lib/server/page-session";
import { ClientInactiveBanner } from "@/components/inactive-banner";

export const metadata: Metadata = { title: "Parent intake" };

export default async function IntakePage({ params }: { params: Promise<{ id: string }> }) {
  const id = await uuidParam(params);
  const ctx = await requirePageCtx();
  const asOf = asOfToday();
  const d = await orNotFound(() => clientDetail(ctx, id, asOf));
  const age = ageYears(toDay(d.client.dob), asOf);
  // Restricted fields are visible to the BCBA only.
  const fields = applicableFields(age).filter(
    (f) => f.sensitivity !== "restricted" || can(ctx.role, "client:read_restricted"),
  );
  // The client record already says whether there is an IEP or IFSP: start the intake answer from it.
  // Only "yes" is carried over; an unticked box may just mean nobody asked yet.
  const initial =
    !("has_iep" in d.answers) && d.client.hasIep ? { ...d.answers, has_iep: { value: true } } : d.answers;
  return (
    <>
      <p>
        <Link href={`/clients/${id}`}>
          ← {d.client.firstName} {d.client.lastName}
        </Link>
      </p>
      <h1>Parent intake</h1>
      <ClientInactiveBanner ctx={ctx} clientId={id} />
      <p className="muted">
        Status: {d.intake?.status ?? "not started"}. Entered by the BCBA from the completed form. Every field
        must be answered or marked none / not applicable before submission. Age-conditional fields appear at
        the applicable age (client is {age}).
      </p>
      {can(ctx.role, "intake:write") ? (
        <IntakeForm clientId={id} fields={fields} initial={initial} canSubmit />
      ) : (
        <p className="alert warn">Your role can view the client but cannot edit the intake.</p>
      )}
    </>
  );
}
