/**
 * Loads everything a plan needs and builds the SourcedContext: every figure a
 * document may show, each with a label (sent to the model) and a source pointer
 * (shown on hover/click). Values are computed by code from stored records only.
 */
import { assessmentCatalog } from "../assessments/catalog";
import { assessmentValues } from "../assessments/plan";
import type { Tx } from "../db";
import { addDays, diffDays, toDay, type Day } from "../dates";
import { SourcedContext, type SourcedValue } from "../firewall";
import { availableHoursPerWeek } from "../intake/derive";
import { DAYS, valueOf, type IntakeAnswers } from "../intake/schema";
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
    include: {
      diagnoses: { orderBy: [{ isPrimary: "desc" }, { icd10Code: "asc" }] },
      payors: { include: { payor: true } },
      attachments: true,
      intakes: true,
    },
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
  // Every assessment of the client; a plan uses the confirmed ones it selects (never notes or files).
  const assessments = await tx.assessment.findMany({
    where: { clientId: client.id },
    include: { scores: true },
    orderBy: [{ administeredOn: "asc" }, { createdAt: "asc" }],
  });
  // Score imports still waiting for review: not usable until confirmed (pre-submission audit only).
  const pendingImports = await tx.assessmentImport.count({
    where: { clientId: client.id, status: "pending" },
  });
  // For the pre-submission audit only (never sent to the AI): when coverage was last confirmed.
  const benefitsChecks = await tx.benefitsCheck.findMany({
    where: { clientId: client.id },
    orderBy: [{ checkedOn: "desc" }, { createdAt: "desc" }],
  });
  return {
    client,
    org,
    auth,
    sessions,
    administrations,
    assessments,
    pendingImports,
    goals,
    letters,
    benefitsChecks,
    intake: client.intakes[0] ?? null,
  };
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
/** A count with its unit, pluralized from the rounded value ("1 hour", "40 hours"). */
export const withUnit = (n: number, one: string, many = `${one}s`) =>
  `${fmt(n)} ${fmt(n) === "1" ? one : many}`;
/** Added to the label of every value whose display already carries its unit. */
export const UNIT_NOTE = " (renders with its unit; do not write the unit after the token)";
/** Milestones per domain at each VB-MAPP level (milestones 1-5, 6-10, 11-15). */
const MILESTONES_PER_DOMAIN = 5;

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
      // The display already names the client ("Bravo's mother"), so the model must not add a name.
      label:
        'Primary caregiver, already written as the client\'s name and the relationship (e.g. "[Client]\'s mother"); use the token alone, never put the client\'s name, a possessive, or "the" before it',
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

  // Every diagnosis on record, primary first (loadClientData orders them that way).
  c.diagnoses.forEach((d, i) => {
    const n = i + 1;
    const role = d.isPrimary ? "primary" : "co-occurring";
    const dsrc = (field: string) => ({
      kind: "diagnosis",
      id: d.id,
      field,
      description: "Diagnosis record",
      href: clientHref,
    });
    add({
      key: `dx.${n}.icd10`,
      label: `Diagnosis ${n} ICD-10 code (${role} diagnosis)`,
      value: d.icd10Code,
      display: d.icd10Code,
      source: dsrc("icd10Code"),
      facts: [`${role} diagnosis`],
    });
    add({
      key: `dx.${n}.label`,
      label: `Diagnosis ${n} DSM-5 code and name (${role} diagnosis)`,
      value: d.dsm5Code,
      display: `${d.dsm5Code} ${d.dsm5Label}`,
      source: dsrc("dsm5Label"),
      facts: [`${role} diagnosis`],
    });
    if (d.evaluationDate)
      add({
        key: `dx.${n}.eval_date`,
        label: `Diagnosis ${n} evaluation date (${role} diagnosis)`,
        value: toDay(d.evaluationDate),
        display: usDate(toDay(d.evaluationDate)),
        source: dsrc("evaluationDate"),
      });
  });
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
    const planType = (b as Partial<PlanBundle>).plan?.type;
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
      label: "Current authorization number (the authorization now in effect, not the requested one)",
      value: a.authNumber,
      display: a.authNumber,
      source: src("authNumber"),
    });
    add({
      key: "auth.start",
      label: "Current authorization start date (the authorization now in effect, not the requested period)",
      value: toDay(a.startDate),
      display: usDate(toDay(a.startDate)),
      source: src("startDate"),
    });
    add({
      key: "auth.end",
      label: "Current authorization end date (the authorization now in effect, not the requested period)",
      value: toDay(a.endDate),
      display: usDate(toDay(a.endDate)),
      source: src("endDate"),
    });
    // A reauthorization asks for the period after the current one. Only its start
    // can be computed; the end depends on what the payor approves.
    if (planType === "reauth") {
      const next = addDays(toDay(a.endDate), 1);
      add({
        key: "auth.requested_start",
        label:
          "Requested (next) authorization period start date: the day after the current authorization ends. The requested end date is not on record.",
        value: next,
        display: usDate(next),
        source: { ...src("endDate"), description: `Day after authorization ${a.authNumber} ends` },
      });
    }
    if (a.recommendedHoursPerWeek)
      add({
        key: "plan.recommended_hours",
        label: `Recommended direct hours per week${UNIT_NOTE}`,
        value: a.recommendedHoursPerWeek,
        display: withUnit(a.recommendedHoursPerWeek, "hour"),
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
        label: `Approved ${u.cptCode} units in the current authorization (${u.unitBasis === "auth" ? "per authorization" : `per ${u.unitBasis}`})${UNIT_NOTE}`,
        value: u.approvedUnits,
        display: withUnit(u.approvedUnits, "unit"),
        source: usrc,
      });
      if (u.unitBasis !== "auth") {
        const perWeek = u.unitBasis === "week" ? u.approvedUnits / 4 : ((u.approvedUnits / 4) * 12) / 52;
        add({
          key: `auth.${u.cptCode}.hours_per_week`,
          label: `Approved ${u.cptCode} hours per week in the current authorization${UNIT_NOTE}`,
          value: perWeek,
          display: withUnit(perWeek, "hour"),
          source: {
            ...usrc,
            description: `${usrc.description} (units ÷ 4${u.unitBasis === "month" ? ", monthly converted to weekly" : ""})`,
          },
        });
      } else {
        add({
          key: `auth.${u.cptCode}.hours`,
          label: `Approved ${u.cptCode} hours for the whole current authorization${UNIT_NOTE}`,
          value: u.approvedUnits / 4,
          display: withUnit(u.approvedUnits / 4, "hour"),
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
      const perAuth = u.unitBasis === "auth";
      const usrc = {
        kind: "service_session",
        description: `Delivered sessions under authorization ${a.authNumber}`,
        href: aHref,
      };
      add({
        key: `util.${u.cptCode}.pct_to_date`,
        label: `${u.cptCode} delivered as a share of approved to date (current authorization)`,
        value: u.pctToDate,
        display: `${Math.round(u.pctToDate * 100)}%`,
        source: usrc,
        // Per-authorization codes (e.g., reassessment) are used once, so a low share is not a gap.
        facts: perAuth
          ? [
              "approved once per authorization (for example, an assessment code), so a low share to date is expected and is not underutilization",
            ]
          : u.flag
            ? [u.flag === "under" ? "under-delivered" : "over-delivered"]
            : [],
      });
      if (perAuth) continue;
      const under = u.weeks.filter((w) => w.flag === "under").length;
      add({
        key: `util.${u.cptCode}.weeks_under`,
        label: `Complete weeks in which ${u.cptCode} delivery fell below the under-delivery threshold (current authorization)${UNIT_NOTE}`,
        value: under,
        display: withUnit(under, "week"),
        source: { ...usrc, description: `Weekly delivery under authorization ${a.authNumber}` },
      });
    }
    const cg = b.sessions.filter((s) => s.cptCode === "97156").length;
    add({
      key: "caregiver.97156.sessions",
      label: `Caregiver training (97156) sessions delivered in the current authorization${UNIT_NOTE}`,
      value: cg,
      display: withUnit(cg, "session"),
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
    const byLevel = new Map<string, [string, number][]>();
    for (const [dk, v] of Object.entries(totals.domains)) {
      const [lvl, dom] = [dk.slice(1, 2), dk.slice(3)];
      byLevel.set(lvl, [...(byLevel.get(lvl) ?? []), [dom, v]]);
    }
    for (const lvl of ["1", "2", "3"])
      if (!ctx.get(`vbmapp.level${lvl}.name`))
        add({
          key: `vbmapp.level${lvl}.name`,
          label: `Name of VB-MAPP Level ${lvl}; write this token whenever you name the level`,
          value: `Level ${lvl}`,
          display: `Level ${lvl}`,
          source: src(`totals.levels.${lvl}`),
        });
    const facts = vbmappFacts(totals.levels, byLevel);
    for (const [lvl, v] of Object.entries(totals.levels)) {
      if (!v) continue;
      add({
        key: `score.L${lvl}.total.admin${k}`,
        label: `VB-MAPP Level ${lvl} total, administration ${k}`,
        value: v,
        display: fmt(v),
        source: src(`totals.levels.${lvl}`),
        facts: facts.level.get(lvl) ?? [],
      });
    }
    for (const [lvl, doms] of byLevel) {
      if (!(totals.levels[lvl] ?? 0)) continue;
      for (const [dom, v] of doms) {
        add({
          key: `score.L${lvl}.${slug(dom)}.admin${k}`,
          label: `VB-MAPP Level ${lvl} ${dom} score, administration ${k}`,
          value: v,
          display: fmt(v),
          source: src(`totals.domains.L${lvl}.${dom}`),
          facts: facts.domain.get(`${lvl}:${dom}`) ?? [],
        });
      }
    }
  }

  // Other assessments: only the confirmed ones the plan selected (VB-MAPP keys above are unchanged).
  const selected = (b as Partial<PlanBundle>).plan?.assessmentIds;
  if (selected?.length)
    for (const v of assessmentValues(assessmentCatalog(), c.id, b.assessments, selected)) add(v);

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
      // The reason is the BCBA's own text, shown from the record; only the date is a value.
      ["discontinuedOn", "discontinued_on", "date discontinued"],
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
      label: `Goal ${n} number of data points${UNIT_NOTE}`,
      value: pts.length,
      display: withUnit(pts.length, "data point"),
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
  // Zero counts (other than the total) invite sentences like "0 goals are on hold": leave them out.
  for (const [k, label, v] of counts.filter(([k, , v]) => k === "total" || v > 0))
    add({
      key: `goals.count.${k}`,
      label: `${label}${UNIT_NOTE}`,
      value: v,
      display: withUnit(v, "goal"),
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
      label: `Family availability, hours per week${UNIT_NOTE}`,
      value: avail,
      display: withUnit(avail, "hour"),
      source: {
        kind: "intake",
        id: b.intake.id,
        field: "availability",
        description: "Parent intake availability grid",
        href: `${clientHref}/intake`,
      },
      facts: availabilityFacts(answers),
    });
  for (const id of ["tantrums", "aggression_frequency"]) {
    const a = answers[id] as { value?: { count: number; per: string; durationMinutes: number } } | undefined;
    if (a?.value && b.intake) {
      add({
        key: `intake.${id}.count`,
        label: `Parent-reported ${id.replace("_frequency", "").replace("_", " ")} episodes per ${a.value.per}, reported at intake (not current data), renders as "N episodes"; write "per ${a.value.per}" after it`,
        value: a.value.count,
        display: withUnit(a.value.count, "episode"),
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
        label: `Parent-reported typical ${id.replace("_frequency", "").replace("_", " ")} duration in minutes, reported at intake (not current data)${UNIT_NOTE}`,
        value: a.value.durationMinutes,
        display: withUnit(a.value.durationMinutes, "minute"),
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

/** Days with and without availability on the intake grid, as words only. */
export function availabilityFacts(answers: IntakeAnswers): string[] {
  const grid = valueOf<Record<string, number[]>>(answers.availability);
  if (!grid) return [];
  const on = DAYS.filter((d) => (grid[d] ?? []).length > 0);
  const off = DAYS.filter((d) => !(grid[d] ?? []).length);
  return [
    on.length ? `family is available on ${on.join(", ")}` : "",
    off.length ? `family is not available on ${off.join(", ")}` : "",
  ].filter(Boolean);
}

/**
 * Qualitative VB-MAPP facts, written so the model cannot misread them: a level
 * where every milestone is met is mastered, and the highest level reached (when
 * lower levels exist and few of its milestones are met) is only emerging, so its domains are never ranked as
 * strengths or weaknesses.
 */
/** The sourced token that names a VB-MAPP level ("Level 2"); the model writes this instead of the number. */
export const levelToken = (lvl: string | number) => `{{vbmapp.level${lvl}.name}}`;

export function vbmappFacts(levels: Record<string, number>, byLevel: Map<string, [string, number][]>) {
  // Facts reach the model, whose output may contain neither digits nor number words: levels are tokens.
  const word = (l: string) => levelToken(l);
  const level = new Map<string, string[]>();
  const domain = new Map<string, string[]>();
  const reached = Object.keys(levels)
    .filter((l) => (levels[l] ?? 0) > 0)
    .sort();
  // The highest level reached is "emerging" while under a quarter of its milestones are met.
  const top = reached.length > 1 ? reached.at(-1)! : undefined;
  const topMax = top ? (byLevel.get(top)?.length ?? 0) * MILESTONES_PER_DOMAIN : 0;
  const emerging = top && (levels[top] ?? 0) < topMax / 4 ? top : undefined;
  for (const [lvl, doms] of byLevel) {
    if (!(levels[lvl] ?? 0)) continue;
    const mastered = doms.length > 0 && doms.every(([, v]) => v >= MILESTONES_PER_DOMAIN);
    const lf: string[] = [];
    if (mastered) lf.push(`every ${word(lvl)} milestone is met: ${word(lvl)} is mastered`);
    if (lvl === emerging)
      lf.push(
        `highest level reached: the client is only beginning ${word(lvl)}, so low scores here mark where new learning starts, not weaknesses`,
      );
    level.set(lvl, lf);
    const values = doms.map(([, v]) => v);
    const low = Math.min(...values);
    const high = Math.max(...values);
    for (const [dom, v] of doms) {
      const f: string[] = [];
      if (v >= MILESTONES_PER_DOMAIN) f.push(`every ${dom} milestone at ${word(lvl)} is met`);
      if (lvl === emerging)
        f.push(`${word(lvl)} is only emerging: do not rank this domain as a strength or a weakness`);
      else if (low === high) {
        if (!mastered) f.push(`same score as every other ${word(lvl)} domain`);
      } else {
        if (v === low) f.push(`lowest domain in ${word(lvl)}`);
        if (v === high) f.push(`highest domain in ${word(lvl)}`);
      }
      domain.set(`${lvl}:${dom}`, f);
    }
  }
  return { level, domain };
}
