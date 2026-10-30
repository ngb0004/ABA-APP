import type { Metadata } from "next";
import Link from "next/link";
import { withOrg } from "@/lib/db";
import { requirePermission } from "@/lib/permissions";
import { requirePageCtx } from "@/lib/server/page-session";

export const metadata: Metadata = { title: "Audit log" };

const PAGE_SIZE = 300;
/** Automatic per-query events ("read:findMany", "write:update"). Hidden unless asked for. */
const AUTO_PREFIXES = ["read:", "write:"];

/** "payor_rule:verify" -> "Payor rule: verify". The raw action stays in the tooltip. */
function actionLabel(action: string): string {
  const [head, ...rest] = action.split(":");
  const h = (head ?? "").replace(/_/g, " ");
  const title = h.charAt(0).toUpperCase() + h.slice(1);
  return rest.length ? `${title}: ${rest.join(":").replace(/_/g, " ")}` : title;
}

export default async function AuditPage({
  searchParams,
}: {
  searchParams: Promise<{ all?: string; before?: string; beforeId?: string }>;
}) {
  const ctx = await requirePageCtx();
  requirePermission(ctx.role, "audit:read");
  const sp = await searchParams;
  const showAll = sp.all === "1";
  const before = sp.before && !Number.isNaN(Date.parse(sp.before)) ? new Date(sp.before) : null;
  // Many events share a millisecond: page by (time, id) so none is skipped at a page boundary.
  const beforeId = sp.beforeId && /^[0-9a-f-]{36}$/i.test(sp.beforeId) ? sp.beforeId : null;
  const { rows, users } = await withOrg(ctx, async (tx) => {
    const rows = await tx.auditEvent.findMany({
      where: {
        ...(before
          ? beforeId
            ? { OR: [{ createdAt: { lt: before } }, { createdAt: before, id: { lt: beforeId } }] }
            : { createdAt: { lt: before } }
          : {}),
        ...(showAll ? {} : { NOT: AUTO_PREFIXES.map((p) => ({ action: { startsWith: p } })) }),
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: PAGE_SIZE,
    });
    // RLS also shows the caller's own memberships elsewhere: scope to this practice.
    const members = await tx.membership.findMany({
      where: { orgId: ctx.orgId },
      include: { user: { select: { name: true, email: true } } },
    });
    return { rows, users: new Map(members.map((m) => [m.userId, m.user.name || m.user.email])) };
  });
  const href = (q: { all?: boolean; before?: string; beforeId?: string }) => {
    const p = new URLSearchParams();
    if (q.all) p.set("all", "1");
    if (q.before) p.set("before", q.before);
    if (q.beforeId) p.set("beforeId", q.beforeId);
    const s = p.toString();
    return s ? `/audit?${s}` : "/audit";
  };
  const last = rows.at(-1);
  return (
    <>
      <h1>Audit log</h1>
      <p className="muted">
        Append-only. Shows {PAGE_SIZE} events at a time for this organization, newest first. IDs only; no
        client details are stored in audit metadata.
      </p>
      <p className="row">
        {showAll ? (
          <Link href={href({ before: sp.before, beforeId: sp.beforeId })} data-testid="audit-hide-auto">
            Hide record reads and writes
          </Link>
        ) : (
          <Link
            href={href({ all: true, before: sp.before, beforeId: sp.beforeId })}
            data-testid="audit-show-auto"
          >
            Show record reads and writes
          </Link>
        )}
        <span className="muted">
          {showAll
            ? "Showing every event, including each automatic record read and write."
            : "Showing sign-ins, approvals, AI calls, exports and other actions. Automatic record reads and writes are hidden."}
        </span>
      </p>
      <div className="panel table-wrap">
        <table className="stack">
          <thead>
            <tr>
              <th>When (UTC)</th>
              <th>User</th>
              <th>Action</th>
              <th>Record</th>
              <th>Meta</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id}>
                <td data-label="When" style={{ whiteSpace: "nowrap" }}>
                  {r.createdAt.toISOString().replace("T", " ").slice(0, 19)}
                </td>
                <td data-label="User" className="muted">
                  {r.userId ? (users.get(r.userId) ?? `former member ${r.userId.slice(0, 8)}`) : "system"}
                </td>
                <td data-label="Action" title={r.action}>
                  {actionLabel(r.action)}
                </td>
                <td data-label="Record">
                  {r.entityType} <span className="muted">{r.entityId?.slice(0, 8)}</span>
                </td>
                <td data-label="Meta">
                  <code style={{ fontSize: 11, overflowWrap: "anywhere" }}>
                    {JSON.stringify(r.meta).slice(0, 160)}
                  </code>
                </td>
              </tr>
            ))}
            {!rows.length && (
              <tr>
                <td colSpan={5} className="muted">
                  No events.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <p className="row">
        {before && <Link href={href({ all: showAll })}>Newest events</Link>}
        {rows.length === PAGE_SIZE && last && (
          <Link href={href({ all: showAll, before: last.createdAt.toISOString(), beforeId: last.id })}>
            Older events
          </Link>
        )}
      </p>
    </>
  );
}
