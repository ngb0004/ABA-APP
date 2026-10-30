import { INACTIVE_FROZEN, INACTIVE_STILL_EDITABLE, inactiveReasonLabel } from "@/lib/client-status";
import { toDay } from "@/lib/dates";
import type { OrgCtx } from "@/lib/db";
import { clientStatusSummary } from "@/lib/services/client-status";

type StatusFields = {
  status: string;
  inactiveSince: Date | null;
  inactiveReason: string | null;
  inactiveNote: string | null;
};

/** "Inactive since <date>: <reason>" at the top of an inactive client's pages. Nothing when active. */
export function InactiveBanner({ client }: { client: StatusFields }) {
  if (client.status !== "inactive") return null;
  return (
    <div className="alert warn" role="status" data-testid="inactive-banner">
      <strong>
        Inactive since {client.inactiveSince ? toDay(client.inactiveSince) : "an unrecorded date"}:{" "}
        {inactiveReasonLabel(client.inactiveReason)}
      </strong>
      {client.inactiveNote && <div>{client.inactiveNote}</div>}
      <div>
        Alerts and due dates are off. {INACTIVE_FROZEN} {INACTIVE_STILL_EDITABLE} Every record stays readable.
        A BCBA can reactivate the client from the ⋯ menu on the client page.
      </div>
    </div>
  );
}

/** For a client's sub-pages: loads the status and shows the banner when the client is inactive. */
export async function ClientInactiveBanner({ ctx, clientId }: { ctx: OrgCtx; clientId: string }) {
  return <InactiveBanner client={await clientStatusSummary(ctx, clientId)} />;
}
