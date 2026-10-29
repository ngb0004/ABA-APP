import type { Role } from "@prisma/client";
import {
  authEndAlert,
  caseloadCalendar,
  DEFAULT_CALENDAR_SETTINGS,
  type CalendarSettings,
} from "../calendar";
import type { OrgCtx, Tx } from "../db";
import { withOrg } from "../db";
import { ageYears, toDay, type Day } from "../dates";
import { availabilityFit, priorEvaluationChecklist, safetyFlags, allowedSigners } from "../intake/derive";
import { FIELD_BY_ID, type IntakeAnswers } from "../intake/schema";
import { registerSensitiveName } from "../log";
import { requirePermission } from "../permissions";
import { redactRestricted } from "../sensitivity";
import { supervisionByMonth } from "../supervision";
import { computeUtilization, type UnitBasis } from "../utilization";
import { evaluateClientRules, loadRules } from "./payors";

export function orgSettings(
  settings: unknown,
): CalendarSettings & { offices: { state: string; address: string }[] } {
  const s = (settings ?? {}) as Partial<CalendarSettings> & {
    offices?: { state: string; address: string }[];
  };
  return {
    reauthLeadDays: s.reauthLeadDays ?? DEFAULT_CALENDAR_SETTINGS.reauthLeadDays,
    reassessmentLeadDays: s.reassessmentLeadDays ?? DEFAULT_CALENDAR_SETTINGS.reassessmentLeadDays,
    alertDays: s.alertDays ?? DEFAULT_CALENDAR_SETTINGS.alertDays,
    offices: s.offices ?? [],
  };
}

export const displayName = (c: { preferredName: string | null; firstName: string }) =>
  c.preferredName || c.firstName;

export async function listClients(ctx: OrgCtx) {
  requirePermission(ctx.role, "client:read");
  return withOrg(ctx, async (tx) => {
    const clients = await tx.client.findMany({
      include: {
        payors: { include: { payor: true } },
        authorizations: { orderBy: { endDate: "desc" }, take: 1 },
      },
      orderBy: { lastName: "asc" },
    });
    for (const c of clients) {
      registerSensitiveName(c.firstName);
      registerSensitiveName(c.lastName);
    }
    return clients;
  });
}

export type ClientAlert = { level: "info" | "warn" | "danger"; message: string; source?: string };

export async function clientDetail(ctx: OrgCtx, clientId: string, asOf: Day) {
  requirePermission(ctx.role, "client:read");
  return withOrg(ctx, async (tx) => {
    const client = await tx.client.findUniqueOrThrow({
      where: { id: clientId },
      include: {
        diagnoses: true,
        payors: { include: { payor: true } },
        attachments: true,
        authorizations: { include: { units: true, payor: true }, orderBy: { endDate: "desc" } },
        intakes: true,
        administrations: { orderBy: { adminNumber: "asc" } },
        plans: { orderBy: { createdAt: "desc" } },
      },
    });
    registerSensitiveName(client.firstName);
    registerSensitiveName(client.lastName);
    const org = await tx.org.findUniqueOrThrow({ where: { id: client.orgId } });
    const settings = orgSettings(org.settings);
    const auth = client.authorizations[0] ?? null;
    const sessions = auth
      ? await tx.serviceSession.findMany({ where: { authorizationId: auth.id }, orderBy: { date: "asc" } })
      : [];
    const intake = client.intakes[0] ?? null;
    const rawAnswers = (intake?.answers ?? {}) as IntakeAnswers;
    const answers = redactRestricted(
      rawAnswers,
      (k) => FIELD_BY_ID.get(k)?.sensitivity ?? "normal",
      ctx.role,
    ) as IntakeAnswers;

    const utilization = auth
      ? computeUtilization(
          {
            startDate: toDay(auth.startDate),
            endDate: toDay(auth.endDate),
            units: auth.units.map((u) => ({
              cptCode: u.cptCode,
              approvedUnits: u.approvedUnits,
              unitBasis: u.unitBasis as UnitBasis,
            })),
          },
          sessions.map((s) => ({ cptCode: s.cptCode, date: toDay(s.date), units: s.units })),
          asOf,
        )
      : [];
    const supervision = auth
      ? supervisionByMonth(
          sessions.map((s) => ({
            cptCode: s.cptCode,
            date: toDay(s.date),
            units: s.units,
            inPerson: s.inPerson,
            providerId: s.providerId,
            providerRole: s.providerRole,
          })),
          { start: toDay(auth.startDate), end: toDay(auth.endDate), asOf },
        )
      : [];
    const { results: ruleResults } = await evaluateClientRules(tx, clientId, asOf);

    const alerts: ClientAlert[] = [];
    if (auth) {
      const a = authEndAlert(toDay(auth.endDate), asOf, settings);
      if (a) alerts.push({ level: a.level <= 14 ? "danger" : "warn", message: a.message });
    }
    for (const u of utilization)
      if (u.flag)
        alerts.push({
          level: "warn",
          message: `${u.cptCode}: ${u.flag === "under" ? "under-delivery" : "over-delivery"} (${Math.round((u.pctToDate ?? 0) * 100)}% of approved to date)`,
        });
    for (const r of ruleResults) {
      if (r.rawStatus !== "fail") continue;
      if (
        [
          "min_sessions_per_auth",
          "supervision_ratio",
          "outcome_measure_schedule",
          "daily_cap",
          "concurrent_billing",
          "request_timing",
        ].includes(r.rule.type)
      ) {
        const label =
          r.rule.type === "min_sessions_per_auth" && String(r.rule.params.code) === "97156"
            ? "Caregiver training shortfall: "
            : "";
        alerts.push({
          level: r.rule.params.severity_if_missed === "hard_alert" ? "danger" : "warn",
          message: `${label}${r.message}${r.rule.verified ? "" : " (unverified rule)"}`,
          source: r.rule.source.name ?? undefined,
        });
      }
    }
    const fit = availabilityFit(rawAnswers, auth?.recommendedHoursPerWeek);
    if (fit.fits === false)
      alerts.push({
        level: "warn",
        message: `Availability (${fit.available} h/week) does not fit recommended hours (${fit.recommended} h/week)`,
      });

    const primaryPayor = client.payors.find((p) => p.priority === "primary");
    const rules = primaryPayor ? await loadRules(tx, primaryPayor.payorId) : [];
    const events = auth
      ? caseloadCalendar(
          [
            {
              clientId,
              authNumber: auth.authNumber,
              startDate: toDay(auth.startDate),
              endDate: toDay(auth.endDate),
              kind: auth.kind as "initial" | "reauth",
              rules,
            },
          ],
          asOf,
          60,
          settings,
        )
      : [];

    return {
      client,
      age: ageYears(toDay(client.dob), asOf),
      auth,
      sessions,
      intake,
      answers,
      utilization,
      supervision,
      ruleResults,
      alerts,
      events,
      safety: safetyFlags(rawAnswers),
      uploads: priorEvaluationChecklist(rawAnswers, client.attachments),
      signers: canSeeRestricted(ctx.role) ? allowedSigners(rawAnswers, client.guardians as never) : null,
      availability: fit,
    };
  });
}

const canSeeRestricted = (role: Role | null) => role === "BCBA";

export async function caseload(ctx: OrgCtx, asOf: Day, days = 60) {
  requirePermission(ctx.role, "client:read");
  return withOrg(ctx, async (tx) => {
    const org = await tx.org.findUniqueOrThrow({ where: { id: ctx.orgId } });
    const settings = orgSettings(org.settings);
    const clients = await tx.client.findMany({
      include: { payors: true, authorizations: { orderBy: { endDate: "desc" }, take: 1 } },
    });
    const auths = [];
    for (const c of clients) {
      const a = c.authorizations[0];
      const p = c.payors.find((x) => x.priority === "primary");
      if (!a) continue;
      auths.push({
        clientId: c.id,
        authNumber: a.authNumber,
        startDate: toDay(a.startDate),
        endDate: toDay(a.endDate),
        kind: a.kind as "initial" | "reauth",
        rules: p ? await loadRules(tx, p.payorId) : [],
      });
    }
    const names = new Map(clients.map((c) => [c.id, displayName(c)]));
    return {
      events: caseloadCalendar(auths, asOf, days, settings).map((e) => ({
        ...e,
        clientName: names.get(e.clientId) ?? "",
      })),
      clients,
    };
  });
}

export async function getClientForTx(tx: Tx, id: string) {
  return tx.client.findUniqueOrThrow({ where: { id }, include: { payors: true, diagnoses: true } });
}
