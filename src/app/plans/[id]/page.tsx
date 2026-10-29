import Link from "next/link";
import { Html } from "@/components/actions";
import { AuditPanel } from "@/components/audit-panel";
import { SectionCard } from "@/components/section-editor";
import { can } from "@/lib/permissions";
import { planView } from "@/lib/services/plans";
import { asOfToday, requirePageCtx } from "@/lib/server/page-session";

export default async function PlanPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await requirePageCtx();
  const v = await planView(ctx, id, asOfToday());
  const b = v.bundle;
  const tokens = v.sourced.map((t) => ({ key: t.key, label: t.label, display: t.display }));
  const approved = v.sections.filter((s) => s.state === "approved").length;
  return (
    <>
      <p>
        <Link href={`/clients/${b.client.id}`}>
          ← {b.client.firstName} {b.client.lastName}
        </Link>
      </p>
      <h1>{b.plan.type === "reauth" ? "Reauthorization" : "Initial"} treatment plan</h1>
      <p className="muted">
        {approved}/{v.sections.length} sections approved · status {b.plan.status} · written against{" "}
        {(b.plan.payorDocVersions as { name: string; version: string }[])
          .map((d) => `${d.name} (${d.version})`)
          .join("; ") || "no payor documents"}
      </p>
      <div className="row" style={{ marginBottom: 12 }}>
        <Link className="btn" href={`/plans/${id}/packet`}>
          Reauth packet and export
        </Link>
        <Link className="btn" href={`/clients/${b.client.id}/goals`}>
          Edit goals
        </Link>
      </div>
      <p className="alert info">
        AI drafts reference figures only as sourced values. Every number below links to its source; hover for
        provenance. Approve each section individually.
      </p>
      {v.sections.map((s) => (
        <SectionCard
          key={s.id}
          planId={id}
          section={{
            key: s.key,
            title: s.title,
            state: s.state,
            ordinal: s.ordinal,
            html: s.html,
            content: s.content,
            items: s.items,
            bcbaOnly: s.bcbaOnly,
          }}
          tokens={tokens}
          canDraft={can(ctx.role, "section:draft")}
          canEdit={can(ctx.role, "section:edit")}
          canApprove={can(ctx.role, "section:approve")}
        />
      ))}
      <div className="panel">
        <h2 style={{ marginTop: 0 }}>Goals and graphs</h2>
        {v.goals.map((g) => (
          <div key={g.id} style={{ marginBottom: 16 }}>
            <h3>
              Goal {g.ordinal}: {g.domain} <span className={`badge ${g.status}`}>{g.status}</span>
            </h3>
            <Html html={g.objectiveHtml} />
            <Html html={g.graph} />
          </div>
        ))}
        {v.grid && (
          <>
            <h3>VB-MAPP Milestones (latest verified)</h3>
            <Html html={v.grid} />
          </>
        )}
      </div>
      <AuditPanel checks={v.checks} />
    </>
  );
}
