/**
 * Loads everything a plan needs and builds the SourcedContext: every figure a
 * document may show, each with a label (sent to the model) and a source pointer
 * (shown on hover/click). Values are computed by code from stored records only.
 */
import type { Tx } from "../db";
import { diffDays, toDay, type Day } from "../dates";
import { SourcedContext, type SourcedValue } from "../firewall";
import { availableHoursPerWeek } from "../intake/derive";
import type { IntakeAnswers } from "../intake/schema";
import { computeUtilization, type UnitBasis } from "../utilization";
import { baseline, current, flatProgress } from "./progress";

export const GOAL_STATUSES = ["new", "in_progress", "mastered", "on_hold", "discontinued"] as const;
export type GoalStatus = (typeof GOAL_STATUSES)[number];
export const GOAL_STATUS_LABEL: Record<GoalStatus, string> = {
  new: "new",
  in_progress: "in progress",
  mastered: "mastered",
  on_hold: "on hold",
  discontinued: "discontinued",
};

export async function loadPlanBundle(tx: Tx, planId: string) {
  const plan = await tx.plan.findUniqueOrThrow({
    where: { id: planId },
    include: { sections: { orderBy: { ordinal: "asc" } }, packet: true },
  });
  return { plan, ...(await loadClientData(tx, plan.clientId, plan.authorizationId)) };
}

/** Client-level data shared by plans and the goals page. */
export async function loadClientData(tx: Tx, clientId: string, authorizationId?: string | null) {
  const client = await tx.client.findUniqueOrThrow({
    where: { id: clientId },
    include: { diagnoses: true, payors: { include: { payor: true } }, attachments: true, intakes: true },
  });
  const org = await tx.org.findUniqueOrThrow({ where: { id: client.orgId } });
  const auth = authorizationId
    ? await tx.authorization.findUnique({
        where: { id: authorizationId },
        include: { units: true, payor: true },
      })
    : await tx.authorization.findFirst({
        where: { clientId },
        include: { units: true, payor: true },
        orderBy: { endDate: "desc" },
      });
  const sessions = auth
    ? await tx.serviceSession.findMany({ where: { authorizationId: auth.id }, orderBy: { date: "asc" } })
    : [];
  const administrations = await tx.vbmappAdministration.findMany({
    where: { clientId: client.id, verified: true },
    include: { scores: true },
    orderBy: { adminNumber: "asc" },
  });
  // Goals belong to the client; every plan for the client works from the same goal records.
  const goals = await tx.goal.findMany({
    where: { clientId },
    include: { dataPoints: { orderBy: { date: "asc" } }, phaseChanges: true },
    orderBy: { ordinal: "asc" },
  });
  const letters = await tx.payorLetter.findMany({
    where: { clientId: client.id },
    orderBy: { createdAt: "desc" },
  });
  return { client, org, auth, sessions, administrations, goals, letters, intake: client.intakes[0] ?? null };
}
export type ClientData = Awaited<ReturnType<typeof loadClientData>>;
export type PlanBundle = Awaited<ReturnType<typeof loadPlanBundle>>;

export const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_|_$/g, "");
const usDate = (d: Day) => `${d.slice(5, 7)}/${d.slice(8, 10)}/${d.slice(0, 4)}`;
const fmt = (n: number) => String(Math.round(n * 10) / 10);

/** Unit shown after a goal's values. */
export const measureUnit = (measure: string) =>
  measure === "percent" ? "%" : measure === "frequency" ? " per session" : " min";

export function goalKeyKind(measure: string) {
  return measure === "percent" ? "pct" : "rate";
}

export function buildSourcedContext(b: ClientData, asOf: Day): SourcedContext {
  const ctx = new SourcedContext();
  const c = b.client;
  const add = (v: SourcedValue) => ctx.add(v);
  const clientHref = `/clients/${c.id}`;
  const name = c.preferredName || c.firstName;

  add({
    key: "client.name",
    label: "Client's preferred name",
    value: name,
    display: name,
    source: {
      kind: "client",
      id: c.id,
      field: "preferredName",
      description: "Client record",
      href: clientHref,
    },
  });
  const age = Math.floor(diffDays(asOf, toDay(c.dob)) / 365.25);
  add({
    key: "client.age_years",
    label: "Client age in years",
    value: age,
    display: String(age),
    source: {
      kind: "client",
      id: c.id,
      field: "dob",
      description: "Computed from date of birth on the client record",
      href: clientHref,
    },
  });
  const guardian =
    ((c.guardians as { relationship: string; legalCustody: boolean }[]) ?? []).find((g) => g.legalCustody) ??
    (c.guardians as { relationship: string }[])[0];
  if (guardian) {
    const disp = `${name}'s ${guardian.relationship.toLowerCase()}`;
    add({
      key: "caregiver.primary",
      label: "Primary caregiver (relationship)",
      value: disp,
      display: disp,
      source: {
        kind: "client",
        id: c.id,
        field: "guardians",
        description: "Guardian on the client record",
        href: clientHref,
      },
    });
  }

  const dx = c.diagnoses.find((d) => d.isPrimary) ?? c.diagnoses[0];
  if (dx) {
    add({
      key: "dx.primary.icd10",
      label: "Primary diagnosis ICD-10 code",
      value: dx.icd10Code,
      display: dx.icd10Code,
      source: {
        kind: "diagnosis",
        id: dx.id,
        field: "icd10Code",
        description: "Diagnosis record",
        href: clientHref,
      },
    });
    add({
      key: "dx.primary.dsm5",
      label: "Primary diagnosis DSM-5 code and label",
      value: dx.dsm5Code,
      display: `${dx.dsm5Code} ${dx.dsm5Label}`,
      source: {
        kind: "diagnosis",
        id: dx.id,
        field: "dsm5Code",
        description: "Diagnosis record",
        href: clientHref,
      },
    });
    if (dx.evaluationDate)
      add({
        key: "dx.eval_date",
        label: "Diagnostic evaluation date",
        value: toDay(dx.evaluationDate),
        display: usDate(toDay(dx.evaluationDate)),
        source: {
          kind: "diagnosis",
          id: dx.id,
          field: "evaluationDate",
          description: "Diagnosis record",
          href: clientHref,
        },
      });
  }

  if (b.auth) {
    const a = b.auth;
    const aHref = `${clientHref}#authorization`;
    const src = (field: string) => ({
      kind: "authorization",
      id: a.id,
      field,
      description: `Authorization ${a.authNumber}`,
      href: aHref,
    });
    add({
      key: "auth.number",
      label: "Authorization number",
      value: a.authNumber,
      display: a.authNumber,
      source: src("authNumber"),
    });
    add({
      key: "auth.start",
      label: "Authorization start date",
      value: toDay(a.startDate),
      display: usDate(toDay(a.startDate)),
      source: src("startDate"),
    });
    add({
      key: "auth.end",
      label: "Authorization end date",
      value: toDay(a.endDate),
      display: usDate(toDay(a.endDate)),
      source: src("endDate"),
    });
    if (a.recommendedHoursPerWeek)
      add({
        key: "plan.recommended_hours",
        label: "Recommended direct hours per week",
        value: a.recommendedHoursPerWeek,
        display: fmt(a.recommendedHoursPerWeek),
        source: src("recommendedHoursPerWeek"),
      });
    for (const u of a.units) {
      const usrc = {
        kind: "authorization_unit",
        id: u.id,
        field: "approvedUnits",
        description: `Authorization ${a.authNumber}, ${u.cptCode}`,
        href: aHref,
      };
      add({
        key: `auth.${u.cptCode}.units`,
        label: `Approved ${u.cptCode} units (${u.unitBasis === "auth" ? "per authorization" : `per ${u.unitBasis}`})`,
        value: u.approvedUnits,
        display: String(u.approvedUnits),
        source: usrc,
      });
      if (u.unitBasis !== "auth") {
        const perWeek = u.unitBasis === "week" ? u.approvedUnits / 4 : ((u.approvedUnits / 4) * 12) / 52;
        add({
          key: `auth.${u.cptCode}.hours_per_week`,
          label: `Approved ${u.cptCode} hours per week`,
          value: perWeek,
          display: fmt(perWeek),
          source: {
            ...usrc,
            description: `${usrc.description} (units ÷ 4${u.unitBasis === "month" ? ", monthly converted to weekly" : ""})`,
          },
        });
      } else {
        add({
          key: `auth.${u.cptCode}.hours`,
          label: `Approved ${u.cptCode} hours this authorization`,
          value: u.approvedUnits / 4,
          display: fmt(u.approvedUnits / 4),
          source: { ...usrc, description: `${usrc.description} (units ÷ 4)` },
        });
      }
    }
    const util = computeUtilization(
      {
        startDate: toDay(a.startDate),
        endDate: toDay(a.endDate),
        units: a.units.map((u) => ({
          cptCode: u.cptCode,
          approvedUnits: u.approvedUnits,
          unitBasis: u.unitBasis as UnitBasis,
        })),
      },
      b.sessions.map((s) => ({ cptCode: s.cptCode, date: toDay(s.date), units: s.units })),
      asOf,
    );
    for (const u of util) {
      if (u.pctToDate === null) continue;
      add({
        key: `util.${u.cptCode}.pct_to_date`,
        label: `${u.cptCode} delivered as a share of approved to date`,
        value: u.pctToDate,
        display: `${Math.round(u.pctToDate * 100)}%`,
        source: {
          kind: "service_session",
          description: `Delivered sessions under authorization ${a.authNumber}`,
          href: aHref,
        },
        facts: u.flag ? [u.flag === "under" ? "under-delivered" : "over-delivered"] : [],
      });
    }
    const cg = b.sessions.filter((s) => s.cptCode === "97156").length;
    add({
      key: "caregiver.97156.sessions",
      label: "Caregiver training (97156) sessions delivered this authorization",
      value: cg,
      display: String(cg),
      source: {
        kind: "service_session",
        description: `97156 sessions under authorization ${a.authNumber}`,
        href: aHref,
      },
    });
  }

  // VB-MAPP: recomputed totals per verified administration, with qualitative facts.
  for (const adm of b.administrations) {
    const k = adm.adminNumber;
    const vHref = `${clientHref}/vbmapp#admin-${k}`;
    const src = (field: string) => ({
      kind: "vbmapp_administration",
      id: adm.id,
      field,
      description: `VB-MAPP administration ${k} (recomputed from the grid)`,
      href: vHref,
    });
    if (adm.testDate)
      add({
        key: `vbmapp.admin${k}.date`,
        label: `VB-MAPP administration ${k} date`,
        value: toDay(adm.testDate),
        display: usDate(toDay(adm.testDate)),
        source: src("testDate"),
      });
    const totals = adm.totals as {
      total: number;
      levels: Record<string, number>;
      domains: Record<string, number>;
    };
    add({
      key: `score.total.admin${k}`,
      label: `VB-MAPP Milestones total, administration ${k}`,
      value: totals.total,
      display: fmt(totals.total),
      source: src("totals.total"),
    });
    for (const [lvl, v] of Object.entries(totals.levels)) {
      if (!v) continue;
      add({
        key: `score.L${lvl}.total.admin${k}`,
        label: `VB-MAPP Level ${lvl} total, administration ${k}`,
        value: v,
        display: fmt(v),
        source: src(`totals.levels.${lvl}`),
      });
    }
    const byLevel = new Map<string, [string, number][]>();
    for (const [dk, v] of Object.entries(totals.domains)) {
      const [lvl, dom] = [dk.slice(1, 2), dk.slice(3)];
      byLevel.set(lvl, [...(byLevel.get(lvl) ?? []), [dom, v]]);
    }
    for (const [lvl, doms] of byLevel) {
      if (!(totals.levels[lvl] ?? 0)) continue;
      const sorted = [...doms].sort((x, y) => x[1] - y[1]);
      const low = sorted[0]![1];
      const high = sorted.at(-1)![1];
      for (const [dom, v] of doms) {
        const facts = [
          v === low ? `lowest domain in Level ${lvl}` : "",
          v === high ? `highest domain in Level ${lvl}` : "",
        ].filter(Boolean);
        add({
          key: `score.L${lvl}.${slug(dom)}.admin${k}`,
          label: `VB-MAPP Level ${lvl} ${dom} score, administration ${k}`,
          value: v,
          display: fmt(v),
          source: src(`totals.domains.L${lvl}.${dom}`),
          facts,
        });
      }
    }
  }

  for (const g of b.goals) {
    const n = g.ordinal;
    const gHref = `${clientHref}/goals#goal-${n}`;
    const pts = g.dataPoints.map((p) => ({ date: toDay(p.date), value: p.value }));
    const kind = goalKeyKind(g.measure);
    const unit = measureUnit(g.measure);
    const src = (description: string) => ({ kind: "goal_data_point", id: g.id, description, href: gHref });
    // A locked baseline (recorded and dated by the BCBA) wins over the computed one.
    const locked = g.baselineLockedAt && g.baselineValue !== null && g.baselineDate;
    const bl = locked ? g.baselineValue : baseline(pts);
    const cur = current(pts);
    const fp = flatProgress(pts, g.measure, asOf);
    const trend = fp.flat
      ? "flat over the last eight weeks"
      : g.measure === "percent"
        ? "improving"
        : "decreasing";
    if (bl !== null)
      add({
        key: `goal.${n}.baseline_${kind}`,
        label: `Goal ${n} (${g.domain}) baseline`,
        value: bl,
        display: `${fmt(bl)}${unit}`,
        source: locked
          ? {
              kind: "goal",
              id: g.id,
              field: "baselineValue",
              description: `Goal ${n} baseline, locked ${usDate(toDay(g.baselineDate!))}`,
              href: gHref,
            }
          : src(`Mean of the first three data points for goal ${n}`),
      });
    if (locked)
      add({
        key: `goal.${n}.baseline_date`,
        label: `Goal ${n} (${g.domain}) baseline date`,
        value: toDay(g.baselineDate!),
        display: usDate(toDay(g.baselineDate!)),
        source: {
          kind: "goal",
          id: g.id,
          field: "baselineDate",
          description: `Goal ${n} baseline date`,
          href: gHref,
        },
      });
    for (const [field, key, label] of [
      ["introducedAt", "introduced", "date introduced"],
      ["projectedMasteryDate", "projected_mastery", "projected mastery date"],
    ] as const) {
      const d = g[field];
      if (d)
        add({
          key: `goal.${n}.${key}`,
          label: `Goal ${n} (${g.domain}) ${label}`,
          value: toDay(d),
          display: usDate(toDay(d)),
          source: { kind: "goal", id: g.id, field, description: `Goal ${n} ${label}`, href: gHref },
        });
    }
    if (cur !== null)
      add({
        key: `goal.${n}.current_${kind}`,
        label: `Goal ${n} (${g.domain}) current level`,
        value: cur,
        display: `${fmt(cur)}${unit}`,
        source: src(`Mean of the last three data points for goal ${n}`),
        facts: [trend],
      });
    add({
      key: `goal.${n}.datapoints`,
      label: `Goal ${n} number of data points`,
      value: pts.length,
      display: String(pts.length),
      source: src(`Data points recorded for goal ${n}`),
    });
    const gsrc = (field: string) => ({
      kind: "goal",
      id: g.id,
      field,
      description: `Goal ${n} mastery criteria`,
      href: gHref,
    });
    add({
      key: `goal.${n}.mastery_pct`,
      label: `Goal ${n} mastery accuracy`,
      value: g.masteryAccuracyPct,
      display: `${g.masteryAccuracyPct}%`,
      source: gsrc("masteryAccuracyPct"),
    });
    add({
      key: `goal.${n}.mastery_sessions`,
      label: `Goal ${n} consecutive sessions for mastery`,
      value: g.masteryConsecutiveSessions,
      display: String(g.masteryConsecutiveSessions),
      source: gsrc("masteryConsecutiveSessions"),
    });
    add({
      key: `goal.${n}.mastery_people`,
      label: `Goal ${n} instructors for mastery`,
      value: g.masteryInstructors,
      display: String(g.masteryInstructors),
      source: gsrc("masteryInstructors"),
    });
  }

  // Goal counts by status, for the goal summary.
  const goalsHref = `${clientHref}/goals`;
  const counts: [string, string, number][] = [
    ["total", "Number of goals", b.goals.length],
    ...GOAL_STATUSES.map((st): [string, string, number] => [
      st,
      `Number of goals ${GOAL_STATUS_LABEL[st]}`,
      b.goals.filter((g) => g.progressStatus === st).length,
    ]),
  ];
  for (const [k, label, v] of counts)
    add({
      key: `goals.count.${k}`,
      label,
      value: v,
      display: String(v),
      source: {
        kind: "goal_records",
        id: c.id,
        description: "Count of goal records by status",
        href: goalsHref,
      },
    });

  const answers = (b.intake?.answers ?? {}) as IntakeAnswers;
  const avail = availableHoursPerWeek(answers);
  if (avail !== null && b.intake)
    add({
      key: "intake.availability_hours",
      label: "Family availability, hours per week",
      value: avail,
      display: fmt(avail),
      source: {
        kind: "intake",
        id: b.intake.id,
        field: "availability",
        description: "Parent intake availability grid",
        href: `${clientHref}/intake`,
      },
    });
  for (const id of ["tantrums", "aggression_frequency"]) {
    const a = answers[id] as { value?: { count: number; per: string; durationMinutes: number } } | undefined;
    if (a?.value && b.intake) {
      add({
        key: `intake.${id}.count`,
        label: `Parent-reported ${id.replace("_frequency", "").replace("_", " ")} episodes per ${a.value.per}`,
        value: a.value.count,
        display: String(a.value.count),
        source: {
          kind: "intake",
          id: b.intake.id,
          field: id,
          description: "Parent intake",
          href: `${clientHref}/intake`,
        },
      });
      add({
        key: `intake.${id}.minutes`,
        label: `Parent-reported typical ${id.replace("_frequency", "").replace("_", " ")} duration in minutes`,
        value: a.value.durationMinutes,
        display: String(a.value.durationMinutes),
        source: {
          kind: "intake",
          id: b.intake.id,
          field: id,
          description: "Parent intake",
          href: `${clientHref}/intake`,
        },
      });
    }
  }
  return ctx;
}
