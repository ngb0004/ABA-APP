import type { Metadata } from "next";
import Link from "next/link";
import { Html } from "@/components/actions";
import { AuditPanel } from "@/components/audit-panel";
import { PlanAssessments } from "@/components/plan-assessments";
import { SectionCard } from "@/components/section-editor";
import { sectionDone } from "@/lib/plan/sections";
import { can } from "@/lib/permissions";
import { planView } from "@/lib/services/plans";
import { asOfToday, orNotFound, requirePageCtx, uuidParam } from "@/lib/server/page-session";
import { InactiveBanner } from "@/components/inactive-banner";

export const metadata: Metadata = { title: "Treatment plan" };

export default async function PlanPage({ params }: { params: Promise<{ id: string }> }) {
  const id = await uuidParam(params);
  const ctx = await requirePageCtx();
  const v = await orNotFound(() => planView(ctx, id, asOfToday()));
  const b = v.bundle;
  const tokens = v.sourced.map((t) => ({ key: t.key, label: t.label, display: t.display }));
  const approved = v.sections.filter((s) => sectionDone(s.state)).length;
  // An inactive client's plan is read-only (drafting, editing, approving, reopening) until reactivated.
  const role = b.client.status === "inactive" ? null : ctx.role;
  return (
    <>
      <p>
        <Link href={`/clients/${b.client.id}`}>
          ← {b.client.firstName} {b.client.lastName}
        </Link>
      </p>
      <h1>{b.plan.type === "reauth" ? "Reauthorization" : "Initial"} treatment plan</h1>
      <InactiveBanner client={b.client} />
      <div className="panel plan-progress">
        <div className="row" style={{ justifyContent: "space-between" }}>
          <strong>
            {approved} of {v.sections.length} sections approved
          </strong>
          <span className="muted">Status: {b.plan.status}</span>
        </div>
        <div className="progress" aria-hidden="true">
          <span style={{ width: `${Math.round((approved / Math.max(1, v.sections.length)) * 100)}%` }} />
        </div>
        <nav className="section-chips" aria-label="Sections">
          {v.sections.map((s) => (
            <a
              key={s.id}
              href={`#section-${s.key}`}
              title={`${s.ordinal}. ${s.title}: ${s.state.replace(/_/g, " ")}`}
              className={`chip ${sectionDone(s.state) ? "done" : s.content.trim() ? "started" : ""}`}
            >
              {s.ordinal}
            </a>
          ))}
        </nav>
        <details>
          <summary className="muted">Payor documents this plan is written against</summary>
          <ul className="muted">
            {(b.plan.payorDocVersions as { name: string; version: string }[]).map((d) => (
              <li key={d.name}>
                {d.name} ({d.version})
              </li>
            ))}
            {!(b.plan.payorDocVersions as unknown[]).length && <li>No payor documents</li>}
          </ul>
        </details>
      </div>
      <PlanAssessments
        planId={id}
        clientId={b.client.id}
        options={v.assessmentOptions}
        canEdit={can(role, "section:edit") && b.plan.status !== "finalized"}
      />
      <div className="row" style={{ marginBottom: 12 }}>
        <Link className="btn" href={`/plans/${id}/packet`}>
          {b.plan.type === "reauth"
            ? "Reauthorization packet and export"
            : "Initial request packet and export"}
        </Link>
        <Link className="btn dark" href={`/clients/${b.client.id}/goals`}>
          {role ? "Edit goals" : "Goals"}
        </Link>
      </div>
      <p className="alert info">
        AI drafts reference figures only as sourced values. Every number below links to its source: hover to
        see where it came from, or tap it to open the source. Approve each section individually.
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
            conditional: s.conditional,
            notApplicableReason: s.notApplicableReason,
            redraftReason: s.redraftReason,
          }}
          tokens={tokens}
          canDraft={can(role, "section:draft")}
          canEdit={can(role, "section:edit")}
          canApprove={can(role, "section:approve")}
        />
      ))}
      <div className="panel">
        <h2 style={{ marginTop: 0 }}>Goals and graphs</h2>
        {v.goals.map((g) => (
          <div key={g.id} style={{ marginBottom: 16 }}>
            <h3>
              {g.name} <span className={`badge ${g.status}`}>{g.status}</span>
              {g.progressStatus === "discontinued" && (
                <>
                  {" "}
                  <span className="badge na">discontinued</span>
                </>
              )}
            </h3>
            {g.progressStatus === "discontinued" && g.discontinuedReason && (
              <p className="muted">Reason discontinued: {g.discontinuedReason}</p>
            )}
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
