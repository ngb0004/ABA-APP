/** Reauth packet: checklist (payor rules + letter requirements), export to one ordered PDF, hand-off status. */
import type { Prisma } from "@prisma/client";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { audit, sha256 } from "../audit";
import { withOrg, type OrgCtx } from "../db";
import { toDay, type Day } from "../dates";
import { renderTokens } from "../firewall";
import { HttpError } from "../log";
import { requirePermission } from "../permissions";
import { buildSourcedContext, type PlanBundle } from "../plan/context";
import { goalGraphSvg } from "../plan/graphs";
import type { RuleResult, ScopeFinding } from "../payors/types";
import { renderMilestonesGridSvg } from "../vbmapp/grid-svg";
import { dayInZone } from "../time-format";
import { orgSettings } from "./clients";
import { evaluateClientRules } from "./payors";
import { GOAL_STATUS_LABEL, measureUnit, type GoalStatus } from "../plan/context";
import { isLegacyPlan, sectionDone } from "../plan/sections";
import { assertExportable, NOT_APPLICABLE_ITEM } from "./plans";
import { loadPlanBundle } from "../plan/context";

export type ChecklistItem = {
  key: string;
  label: string;
  status: "ok" | "missing" | "warn" | "todo";
  source: "auto" | "payor_rule" | "letter";
  action?: string;
  done?: boolean;
};

export function buildChecklist(
  b: PlanBundle,
  results: RuleResult[],
  done: Record<string, boolean>,
  scope: ScopeFinding[] = [],
): ChecklistItem[] {
  const items: ChecklistItem[] = [];
  const approved = b.plan.sections.every((s) => sectionDone(s.state));
  items.push({
    key: "auto:plan",
    label: "Treatment plan (all sections approved)",
    status: approved ? "ok" : "missing",
    source: "auto",
    action: approved ? undefined : "Approve every section",
  });
  items.push({
    key: "auto:graphs",
    label: `Progress graphs for ${b.goals.length} goal(s)`,
    status: b.goals.every((g) => g.dataPoints.length) ? "ok" : "missing",
    source: "auto",
  });
  items.push({
    key: "auto:vbmapp",
    label: "VB-MAPP Milestones grid",
    status: b.administrations.length ? "ok" : "missing",
    source: "auto",
    action: b.administrations.length ? undefined : "Import and verify a VB-MAPP",
  });
  for (const a of b.client.attachments)
    items.push({ key: `auto:att:${a.id}`, label: `Attachment: ${a.title}`, status: "ok", source: "auto" });
  for (const r of results) {
    if (
      ![
        "required_document",
        "outcome_measure_schedule",
        "signature_type",
        "event_trigger",
        "submission_channel",
      ].includes(r.rule.type) ||
      r.status === "n/a"
    )
      continue;
    const missing = r.rawStatus === "fail";
    const key = `rule:${r.rule.id}`;
    items.push({
      key,
      label: r.message,
      status: missing ? (r.rule.verified ? "missing" : "warn") : r.rawStatus === "warn" ? "todo" : "ok",
      source: "payor_rule",
      action: missing
        ? r.rule.source.url
          ? `Obtain from ${r.rule.source.name}: ${r.rule.source.url}`
          : "Obtain and attach"
        : r.rawStatus === "warn"
          ? "Manual check"
          : undefined,
      done: done[key],
    });
  }
  for (const f of scope)
    items.push({
      key: f.id,
      label: f.message,
      status: "warn",
      source: "payor_rule",
      action: "Check the client's insurance on Records",
    });
  const letter = b.letters.find((l) => l.status === "confirmed");
  if (letter) {
    const ex = letter.extracted as {
      requirements?: string[];
      fields?: { field: string; value: unknown; verified: boolean }[];
    };
    (ex.requirements ?? []).forEach((req, i) => {
      const key = `letter:${letter.id}:${i}`;
      items.push({
        key,
        label: `Letter requirement: ${req}`,
        status: done[key] ? "ok" : "todo",
        source: "letter",
        done: done[key],
      });
    });
    for (const f of (ex.fields ?? []).filter((x) => x.field === "deadline" && x.verified))
      items.push({
        key: `letter:${letter.id}:deadline`,
        label: `Letter deadline: ${String(f.value)}`,
        status: "todo",
        source: "letter",
      });
  }
  return items;
}

export async function packetView(ctx: OrgCtx, planId: string, asOf: Day) {
  requirePermission(ctx.role, "client:read");
  return withOrg(ctx, async (tx) => {
    const b = await loadPlanBundle(tx, planId);
    const { results, scope } = await evaluateClientRules(tx, b.client.id, asOf, planId);
    const done = ((b.plan.packet?.checklist as { done?: Record<string, boolean> } | null)?.done ??
      {}) as Record<string, boolean>;
    return { bundle: b, checklist: buildChecklist(b, results, done, scope), packet: b.plan.packet };
  });
}

export async function setChecklistDone(ctx: OrgCtx, planId: string, key: string, value: boolean) {
  requirePermission(ctx.role, "packet:manage");
  return withOrg(ctx, async (tx) => {
    const p = await tx.packet.upsert({ where: { planId }, create: { orgId: ctx.orgId, planId }, update: {} });
    const done = {
      ...(((p.checklist as { done?: Record<string, boolean> }) ?? {}).done ?? {}),
      [key]: value,
    };
    await tx.packet.update({ where: { id: p.id }, data: { checklist: { done } as Prisma.InputJsonValue } });
  });
}

function notApplicableReason(items: unknown): string | null {
  return (items as Record<string, { note?: string }> | null)?.[NOT_APPLICABLE_ITEM]?.note ?? null;
}

/** Dates, status, baseline, settings, and barriers from the goal record (system-filled, never AI). */
function goalRecordTable(g: PlanBundle["goals"][number]): string {
  const d = (x: Date | null) => (x ? toDay(x) : "not recorded");
  const rows: [string, string][] = [
    ["Status", GOAL_STATUS_LABEL[g.progressStatus as GoalStatus] ?? g.progressStatus],
    ["Date introduced", d(g.introducedAt)],
    ["Projected mastery", d(g.projectedMasteryDate)],
    [
      "Baseline",
      g.baselineLockedAt && g.baselineValue !== null
        ? `${Math.round(g.baselineValue * 10) / 10}${measureUnit(g.measure)} (recorded ${d(g.baselineDate)})`
        : "not locked",
    ],
  ];
  if (g.progressStatus === "discontinued" && g.discontinuedOn) {
    rows.push(["Discontinued on", d(g.discontinuedOn)]);
    if (g.discontinuedReason) rows.push(["Reason discontinued (BCBA)", g.discontinuedReason]);
  }
  const settings = (g.settings as string[] | null) ?? [];
  if (settings.length) rows.push(["Settings", settings.join(", ")]);
  if (g.barriers.trim()) rows.push(["Barriers", g.barriers]);
  return `<table class="goal-record">${rows.map(([k, v]) => `<tr><th>${k}</th><td>${esc(v)}</td></tr>`).join("")}</table>`;
}

const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

export function packetHtml(b: PlanBundle, results: RuleResult[], asOf: Day): string {
  const sourced = buildSourcedContext(b, asOf);
  const c = b.client;
  // Approval is a stored instant: show the day it was in the practice's zone, not in UTC.
  const timeZone = orgSettings(b.org.settings).timeZone;
  const forms = results.filter(
    (r) => r.rule.type === "required_document" && /form|cover|request/i.test(String(r.rule.params.doc)),
  );
  const used = new Set<string>();
  const render = (t: string) => {
    for (const m of t.matchAll(/\{\{([^}]+)\}\}/g)) used.add(m[1]!);
    return renderTokens(t, sourced, "html");
  };
  const sections = b.plan.sections
    .map((s) =>
      s.state === "not_applicable"
        ? `<section><h2>${s.ordinal}. ${esc(s.title)}</h2><p>Not applicable to this request${notApplicableReason(s.items) ? `: ${esc(notApplicableReason(s.items)!)}` : ""}.</p></section>`
        : `<section><h2>${s.ordinal}. ${esc(s.title)}</h2>${render(s.content)
            .split(/\n{2,}/)
            .map((p) => `<p>${p.replace(/\n/g, "<br>")}</p>`)
            .join(
              "",
            )}<p class="meta">Approved by BCBA ${s.approvedAt ? dayInZone(s.approvedAt, timeZone) : ""}</p></section>`,
    )
    .join("");
  // Plans written with the eleven-section structure export exactly as before.
  const legacy = isLegacyPlan(b.plan.sections.map((s) => s.key));
  const goals = b.goals
    .map(
      (g) =>
        `<div class="goal"><h3>Goal ${g.ordinal}: ${esc(g.domain)}</h3><p>${render(g.objective)}</p><p class="rationale"><em>Medical necessity:</em> ${render(g.rationale)}</p>${legacy ? "" : goalRecordTable(g)}${g.flatExplanation ? `<p><em>Progress note:</em> ${esc(g.flatExplanation)}</p>` : ""}${goalGraphSvg({ title: `Goal ${g.ordinal}: ${g.domain}`, measure: g.measure, points: g.dataPoints.map((p) => ({ date: toDay(p.date), value: p.value })), phaseChanges: g.phaseChanges.map((p) => ({ date: toDay(p.date), label: p.label })), masteryPct: g.masteryAccuracyPct })}</div>`,
    )
    .join("");
  const latest = b.administrations.at(-1);
  const grid = latest
    ? renderMilestonesGridSvg(
        latest.scores.map((s) => ({
          level: s.level,
          domain: s.domain,
          milestone: s.milestone,
          score: s.score as 0.5 | 1,
          firstAdmin: s.firstAdmin,
        })),
        b.administrations.map((a) => ({
          adminNumber: a.adminNumber,
          label: `Admin ${a.adminNumber}${a.testDate ? ` (${toDay(a.testDate)})` : ""}`,
        })),
      )
    : "<p>No verified VB-MAPP.</p>";
  const sources = [...used]
    .sort()
    .map((k) => sourced.get(k))
    .filter(Boolean)
    .map(
      (v) =>
        `<tr><td>${esc(v!.label)}</td><td>${esc(v!.display)}</td><td>${esc(v!.source.description)}</td></tr>`,
    )
    .join("");
  const primary = c.payors.find((p) => p.priority === "primary");
  return `<!doctype html><html><head><meta charset="utf-8"><title>Treatment plan</title><style>
    body{font-family:Helvetica,Arial,sans-serif;font-size:11pt;color:#111;margin:0}
    .page{page-break-after:always;padding:8px 0}
    h1{font-size:18pt;margin:0 0 8px} h2{font-size:13pt;border-bottom:1px solid #999;margin-top:18px} h3{font-size:11.5pt;margin-bottom:4px}
    .meta{color:#555;font-size:9pt} a.sourced{color:#111;text-decoration:underline dotted}
    table{border-collapse:collapse;width:100%;font-size:9pt} td,th{border:1px solid #bbb;padding:3px 5px;text-align:left}
    .goal{page-break-inside:avoid;margin-bottom:12px} svg{max-width:100%;height:auto}
    .placeholder{border:2px dashed #888;padding:16px;margin-top:12px}
  </style></head><body>
  <div class="page"><h1>${esc(b.org.name)}: ${b.plan.type === "reauth" ? "Reauthorization request" : "Initial treatment request"}</h1>
    <table><tr><th>Client</th><td>${esc(c.firstName)} ${esc(c.lastName)}</td></tr><tr><th>Date of birth</th><td>${toDay(c.dob)}</td></tr>
    <tr><th>Payor</th><td>${esc(primary?.payor.name ?? "")}</td></tr><tr><th>Member ID</th><td>${esc(primary?.memberId ?? "")}</td></tr>
    <tr><th>Authorization</th><td>${esc(b.auth?.authNumber ?? "")}</td></tr><tr><th>Prepared</th><td>${asOf}</td></tr></table>
    <div class="placeholder"><strong>Payor request form (placeholder).</strong> Payor PDF form filling is not automated in v1.0. Complete the official form:
      <ul>${forms.map((f) => `<li>${esc(String(f.rule.params.doc))}${f.rule.source.url ? `: <a href="${esc(f.rule.source.url)}">${esc(f.rule.source.url)}</a>` : " (obtain from the payor portal)"}</li>`).join("") || "<li>No payor form rule on file.</li>"}</ul></div>
    <p class="meta">Written against: ${(b.plan.payorDocVersions as { name: string; version: string }[]).map((d) => `${esc(d.name)} (${esc(d.version)})`).join("; ")}</p>
  </div>
  <div class="page"><h1>Treatment plan</h1>${sections}</div>
  <div class="page"><h1>Goals and progress graphs</h1>${goals}</div>
  <div class="page"><h1>VB-MAPP Milestones</h1>${grid}</div>
  <div class="page"><h1>Attachments</h1><ul>${c.attachments.map((a) => `<li>${esc(a.title)}${a.documentDate ? ` (${toDay(a.documentDate)})` : ""}</li>`).join("")}</ul>
    <h2>Sources for figures in this document</h2><table><tr><th>Value</th><th>Shown</th><th>Source</th></tr>${sources}</table></div>
  </body></html>`;
}

export const EXPORT_DIR = path.join(process.cwd(), "exports");

export async function exportPacketPdf(
  ctx: OrgCtx,
  planId: string,
  asOf: Day,
): Promise<{ pdf: Buffer; sha256: string }> {
  requirePermission(ctx.role, "export:pdf");
  return withOrg(ctx, async (tx) => {
    const { bundle, results } = await assertExportable(tx, planId, asOf);
    const html = packetHtml(bundle, results, asOf);
    const { chromium } = await import("playwright");
    const browser = await chromium.launch();
    let pdf: Buffer;
    try {
      const page = await browser.newPage();
      // The document is self-contained; block any network access while rendering.
      await page.route("**/*", (r) => r.abort());
      await page.setContent(html, { waitUntil: "load" });
      pdf = Buffer.from(
        await page.pdf({
          format: "Letter",
          margin: { top: "0.6in", bottom: "0.6in", left: "0.6in", right: "0.6in" },
          printBackground: true,
        }),
      );
    } finally {
      await browser.close();
    }
    const hash = sha256(pdf);
    await mkdir(EXPORT_DIR, { recursive: true });
    await writeFile(path.join(EXPORT_DIR, `${planId}.pdf`), pdf);
    await tx.packet.upsert({
      where: { planId },
      create: { orgId: ctx.orgId, planId, status: "ready", pdfSha256: hash, exportedAt: new Date() },
      update: { status: "ready", pdfSha256: hash, exportedAt: new Date() },
    });
    await tx.plan.update({ where: { id: planId }, data: { status: "finalized", finalizedAt: new Date() } });
    await audit(tx, {
      action: "packet:export",
      entityType: "Plan",
      entityId: planId,
      meta: { sha256: hash },
    });
    return { pdf, sha256: hash };
  });
}

export async function markSubmitted(ctx: OrgCtx, planId: string) {
  requirePermission(ctx.role, "packet:manage");
  return withOrg(ctx, async (tx) => {
    const p = await tx.packet.findUnique({ where: { planId } });
    if (!p || p.status !== "ready") throw new HttpError(409, "Export the packet before marking it submitted");
    await tx.packet.update({ where: { id: p.id }, data: { status: "submitted", submittedAt: new Date() } });
    await audit(tx, { action: "packet:submitted", entityType: "Plan", entityId: planId });
  });
}
