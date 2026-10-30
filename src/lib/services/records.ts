/**
 * Data entry: clients, insurance, diagnoses, authorizations, attachments,
 * sessions, goal data, practice settings, and team members.
 *
 * v1.0 holds synthetic data only (CLAUDE.md rule 1), so entry is built to keep
 * it that way: a new client needs an explicit "this client is fictional"
 * confirmation, member and authorization numbers must carry the SYN- prefix the
 * synthetic dataset uses, and attachments record metadata only (no file
 * contents). Every write goes through withOrg (RLS + audit).
 */
import type { Prisma, Role } from "@prisma/client";
import { z } from "zod";
import { audit } from "../audit";
import { hashPassword } from "../auth/local";
import { withOrg, withUser, type OrgCtx, type Tx } from "../db";
import { dayToDate, toDay } from "../dates";
import { HttpError, registerSensitiveName } from "../log";
import { RECORDED_EVENTS } from "../payors/evaluate";
import { looksLikePhiInNote } from "../rules-watch/text";
import {
  BENEFITS_CHECK_METHODS,
  checksForInsurance,
  PLAN_FUNDING,
  planTypeFromFunding,
  YES_NO_UNKNOWN,
} from "../payors/benefits";
import { PLAN_TYPES, US_STATES, type PlanType } from "../payors/types";
import { isDemo } from "../demo";
import { requirePermission } from "../permissions";

// ---------------------------------------------------------------- shared schemas

/** A real calendar date, YYYY-MM-DD. */
export const DaySchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Use a date (YYYY-MM-DD)")
  .refine((s) => {
    const d = dayToDate(s);
    return !Number.isNaN(d.getTime()) && toDay(d) === s;
  }, "Not a real calendar date");

/** Identifiers in v1.0 are synthetic and say so, like the demo data (SYN-AMG-000101). */
const SynId = z
  .string()
  .trim()
  .regex(
    /^SYN-[A-Z0-9-]{3,40}$/,
    "Use a synthetic identifier starting with SYN- (v1.0 holds fictional data only)",
  );

const Text = (max: number) => z.string().trim().min(1).max(max);
const OptText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .optional()
    .nullable()
    .transform((v) => (v ? v : null));

export const DEFICIT_AREAS = [
  "communication",
  "social_interaction",
  "restricted_repetitive_behavior",
  "adaptive",
  "safety",
] as const;
export const CPT_CODES = [
  "97151",
  "97152",
  "97153",
  "97154",
  "97155",
  "97156",
  "97157",
  "97158",
  "0362T",
  "0373T",
] as const;
export const ATTACHMENT_KINDS = [
  "diagnostic_evaluation",
  "iep",
  "ifsp",
  "prior_evaluation",
  "outcome_measure",
  "payor_form",
  "other",
] as const;
export const SESSION_ROLES = ["BCBA", "BCaBA", "RBT"] as const;
/**
 * Who may deliver each code, from the CPT code descriptors (not payor rules): assessment,
 * protocol modification, family guidance, and group adaptive treatment are BCBA/BCaBA work;
 * technician-level codes (97153, 97154, 0362T, 0373T) may be delivered by an RBT. 97152 is a
 * technician-administered assessment under BCBA direction, so any session role may record it.
 */
export const CPT_PROVIDER_ROLES: Record<
  (typeof CPT_CODES)[number],
  readonly (typeof SESSION_ROLES)[number][]
> = {
  "97151": ["BCBA", "BCaBA"],
  "97152": ["BCBA", "BCaBA", "RBT"],
  "97153": ["BCBA", "BCaBA", "RBT"],
  "97154": ["BCBA", "BCaBA", "RBT"],
  "97155": ["BCBA", "BCaBA"],
  "97156": ["BCBA", "BCaBA"],
  "97157": ["BCBA", "BCaBA"],
  "97158": ["BCBA", "BCaBA"],
  "0362T": ["BCBA", "BCaBA", "RBT"],
  "0373T": ["BCBA", "BCaBA", "RBT"],
};
export const MEMBER_ROLES = ["BCBA", "BCaBA", "RBT", "AUTH_COORDINATOR"] as const;

const Guardian = z.object({
  name: Text(80),
  relationship: Text(40),
  legalCustody: z.boolean(),
  canSign: z.boolean().default(false),
});

const ClientFields = z.object({
  firstName: Text(60),
  lastName: Text(60),
  preferredName: OptText(60),
  dob: DaySchema,
  sex: OptText(20),
  serviceAddress: z.object({
    line1: Text(120),
    city: Text(60),
    state: z
      .string()
      .trim()
      .regex(/^[A-Z]{2}$/, "Two-letter state"),
    zip: z
      .string()
      .trim()
      .regex(/^\d{5}$/, "Five-digit ZIP"),
  }),
  // No defaults here: in the partial update schema a default would overwrite fields not sent.
  guardians: z.array(Guardian).max(6),
  hasIep: z.boolean(),
  events: z.array(z.enum(RECORDED_EVENTS as [string, ...string[]])),
});
export const NewClientSchema = ClientFields.extend({
  guardians: ClientFields.shape.guardians.default([]),
  hasIep: ClientFields.shape.hasIep.default(false),
  events: ClientFields.shape.events.default([]),
  fictional: z.literal(true, { message: "Confirm the client is fictional (v1.0 holds synthetic data only)" }),
});
export const ClientUpdateSchema = ClientFields.partial();
/** Fields a demo visitor may set: the identity is generated, never typed (the demo is not HIPAA hosting). */
const DemoClientSchema = z.object({
  ageYears: z.number().int().min(1).max(21),
  hasIep: z.boolean().default(false),
  events: ClientFields.shape.events.default([]),
});
const DemoUpdateSchema = ClientFields.pick({ hasIep: true, events: true }).partial();
const IDENTITY_FIELDS = [
  "firstName",
  "lastName",
  "preferredName",
  "dob",
  "sex",
  "serviceAddress",
  "guardians",
];

const FICTIONAL_FIRST = [
  "Delta",
  "Echo",
  "Foxtrot",
  "Golf",
  "Hotel",
  "India",
  "Juliet",
  "Kilo",
  "Lima",
  "Mike",
  "November",
  "Oscar",
  "Papa",
  "Quebec",
  "Romeo",
  "Sierra",
  "Tango",
  "Uniform",
  "Victor",
  "Whiskey",
  "Xray",
  "Yankee",
  "Zulu",
];

export const ClientPayorSchema = z.object({
  payorId: z.string().uuid(),
  priority: z.enum(["primary", "secondary"]),
  memberId: SynId,
  planName: OptText(80),
  /** Blank means not recorded yet: every rule still applies, with a warning to confirm it. */
  planType: z
    .enum(PLAN_TYPES)
    .nullable()
    .optional()
    .transform((v) => v ?? "unknown"),
  /** Blank means the plan was issued in the client's service state. */
  planState: z
    .enum(US_STATES)
    .nullable()
    .optional()
    .transform((v) => v ?? null),
  secondaryDocsSigned: z.boolean().default(false),
});

/** A benefits check (VOB) on one insurance. Blank optional fields are stored as not recorded. */
export const BenefitsCheckSchema = z.object({
  checkedOn: DaySchema,
  method: z.enum(BENEFITS_CHECK_METHODS),
  /** The call or portal reference number; synthetic in v1.0, like every identifier. */
  referenceNumber: SynId.nullable()
    .optional()
    .transform((v) => v ?? null),
  abaCovered: z.enum(YES_NO_UNKNOWN),
  priorAuthRequired: z.enum(YES_NO_UNKNOWN),
  planFunding: z.enum(PLAN_FUNDING),
  ageLimitYears: z
    .number()
    .int()
    .min(1)
    .max(99)
    .nullable()
    .optional()
    .transform((v) => v ?? null),
  visitOrHourLimits: OptText(300),
  notes: OptText(1000),
});

export const DiagnosisSchema = z.object({
  dsm5Code: Text(20),
  dsm5Label: Text(120),
  icd10Code: z
    .string()
    .trim()
    .regex(/^[A-Z]\d{2}(\.[A-Z0-9]{1,4})?$/, "ICD-10 code, e.g. F84.0"),
  isPrimary: z.boolean().default(false),
  severity: OptText(60),
  evaluationDate: DaySchema.nullable().optional(),
  deficitAreas: z.array(z.enum(DEFICIT_AREAS)).min(1, "Choose at least one deficit area"),
});

export const AuthorizationSchema = z
  .object({
    payorId: z.string().uuid(),
    authNumber: SynId,
    kind: z.enum(["initial", "reauth"]),
    startDate: DaySchema,
    endDate: DaySchema,
    recommendedHoursPerWeek: z.number().min(0).max(60).nullable().optional(),
    units: z
      .array(
        z.object({
          cptCode: z.enum(CPT_CODES),
          approvedUnits: z.number().int().min(1).max(10_000),
          unitBasis: z.enum(["week", "month", "auth"]),
        }),
      )
      .min(1, "Add at least one approved CPT code")
      .max(12),
  })
  .refine((a) => a.endDate > a.startDate, {
    message: "End date must be after the start date",
    path: ["endDate"],
  })
  .refine((a) => new Set(a.units.map((u) => u.cptCode)).size === a.units.length, {
    message: "List each CPT code once",
    path: ["units"],
  });

export const AttachmentSchema = z.object({
  kind: z.enum(ATTACHMENT_KINDS),
  title: Text(120),
  documentDate: DaySchema.nullable().optional(),
  caregiverSigned: z.boolean().default(false),
});

export const SessionSchema = z.object({
  authorizationId: z.string().uuid(),
  cptCode: z.enum(CPT_CODES),
  date: DaySchema,
  startMinute: z
    .number()
    .int()
    .min(0)
    .max(24 * 60 - 15),
  units: z.number().int().min(1).max(48),
  providerRole: z.enum(SESSION_ROLES),
  /** Opaque staff code (e.g. "RBT-A"), never a name. */
  providerId: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9-]{1,20}$/, "A short staff code such as RBT-A (no names)"),
  inPerson: z.boolean().default(true),
});

export const DataPointSchema = z.object({
  date: DaySchema,
  value: z.number().min(0).max(10_000),
  trials: z.number().int().min(1).max(500).nullable().optional(),
});

export const SettingsSchema = z.object({
  name: Text(120),
  npi: OptText(40),
  taxId: OptText(40),
  offices: z
    .array(
      z.object({
        state: z
          .string()
          .trim()
          .regex(/^[A-Z]{2}$/, "Two-letter state"),
        address: Text(200),
      }),
    )
    .max(20),
  reauthLeadDays: z.number().int().min(1).max(120),
  reassessmentLeadDays: z.number().int().min(1).max(180),
  /** Where the practice works: the Payor rules page shows these states (plus nationwide payors) first. */
  statesServed: z
    .array(z.enum(US_STATES))
    .max(US_STATES.length)
    .optional()
    .transform((v) => (v ? [...new Set(v)].sort() : undefined)),
});

export const NewMemberSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(120),
  name: Text(80),
  role: z.enum(MEMBER_ROLES),
  /** Temporary password; the person sets up their authenticator at first sign-in. */
  password: z.string().min(12, "At least 12 characters").max(200),
});

// ---------------------------------------------------------------- helpers

const day = (d: string | null | undefined) => (d ? dayToDate(d) : null);

/** Records describe what already happened: a date after "today" is a typo, and it skews audits and baselines. */
function assertNotFuture(d: string | null | undefined, asOf: string, what: string) {
  if (d && d > asOf) throw new HttpError(422, `${what} cannot be in the future (today is ${asOf})`);
}

/** Staff codes are opaque, but one that names a different role (e.g. "BCBA-Q" on an RBT row) is a mix-up. */
function assertStaffCodeMatchesRole(providerId: string, role: string) {
  const prefix = /^(BCBA|BCABA|RBT)(-|$)/i.exec(providerId)?.[1]?.toUpperCase();
  if (prefix && prefix !== role.toUpperCase())
    throw new HttpError(
      422,
      `The staff code ${providerId} looks like a ${prefix === "BCABA" ? "BCaBA" : prefix} code, but the provider role is ${role}`,
    );
}

async function assertOrgPayor(tx: Tx, payorId: string) {
  // RLS already hides other orgs' payors; a miss is a 422, not a 500.
  if (!(await tx.payor.findUnique({ where: { id: payorId }, select: { id: true } })))
    throw new HttpError(422, "Unknown payor");
}

async function clientOf(tx: Tx, clientId: string) {
  const c = await tx.client.findUnique({ where: { id: clientId } });
  if (!c) throw new HttpError(404, "Not found");
  return c;
}

const note = (
  tx: Tx,
  action: string,
  entityType: string,
  entityId: string,
  meta: Prisma.InputJsonValue = {},
) => audit(tx, { action, entityType, entityId, meta });

// ---------------------------------------------------------------- clients

/** Demo site: a generated fictional identity, so no real person's details can be typed in. */
async function createDemoClient(ctx: OrgCtx, input: unknown, asOf: string) {
  const v = DemoClientSchema.parse(input);
  return withOrg(ctx, async (tx) => {
    const n = await tx.client.count();
    const first = FICTIONAL_FIRST[n % FICTIONAL_FIRST.length]!;
    const round = Math.floor(n / FICTIONAL_FIRST.length);
    const year = Number(asOf.slice(0, 4)) - v.ageYears;
    const c = await tx.client.create({
      data: {
        orgId: ctx.orgId,
        isSynthetic: true,
        firstName: first,
        lastName: round ? `Testchild${round + 1}` : "Testchild",
        dob: dayToDate(`${year}${asOf.slice(4, 8)}01`),
        serviceAddress: { line1: `${n + 1} Fiction Way`, city: "Example City", state: "GA", zip: "30000" },
        guardians: [
          {
            name: `Pat Test${first.toLowerCase()}`,
            relationship: "parent",
            legalCustody: true,
            canSign: true,
          },
        ],
        hasIep: v.hasIep,
        events: v.events,
      },
      select: { id: true },
    });
    await note(tx, "client:create", "Client", c.id, { synthetic: true, generated: true });
    return c;
  });
}

export async function createClient(ctx: OrgCtx, input: unknown, asOf: string = toDay(new Date())) {
  requirePermission(ctx.role, "client:write");
  if (isDemo()) return createDemoClient(ctx, input, asOf);
  const v = NewClientSchema.parse(input);
  registerSensitiveName(v.firstName);
  registerSensitiveName(v.lastName);
  return withOrg(ctx, async (tx) => {
    const c = await tx.client.create({
      data: {
        orgId: ctx.orgId,
        isSynthetic: true,
        firstName: v.firstName,
        lastName: v.lastName,
        preferredName: v.preferredName,
        dob: dayToDate(v.dob),
        sex: v.sex,
        serviceAddress: v.serviceAddress,
        guardians: v.guardians,
        hasIep: v.hasIep,
        events: v.events,
      },
      select: { id: true },
    });
    await note(tx, "client:create", "Client", c.id, { synthetic: true });
    return c;
  });
}

export async function updateClient(ctx: OrgCtx, clientId: string, input: unknown) {
  requirePermission(ctx.role, "client:write");
  if (isDemo() && IDENTITY_FIELDS.some((k) => k in ((input ?? {}) as object)))
    throw new HttpError(
      403,
      "The demo site generates fictional names, dates, and addresses; they cannot be edited here.",
    );
  const v: z.infer<typeof ClientUpdateSchema> = isDemo()
    ? DemoUpdateSchema.parse(input)
    : ClientUpdateSchema.parse(input);
  registerSensitiveName(v.firstName);
  registerSensitiveName(v.lastName);
  return withOrg(ctx, async (tx) => {
    await clientOf(tx, clientId);
    const { dob, ...rest } = v;
    await tx.client.update({
      where: { id: clientId },
      data: { ...rest, ...(dob ? { dob: dayToDate(dob) } : {}) },
    });
    await note(tx, "client:update", "Client", clientId, { fields: Object.keys(v) });
  });
}

// ---------------------------------------------------------------- insurance

export async function saveClientPayor(ctx: OrgCtx, clientId: string, id: string | null, input: unknown) {
  requirePermission(ctx.role, "insurance:manage");
  const v = ClientPayorSchema.parse(input);
  return withOrg(ctx, async (tx) => {
    await clientOf(tx, clientId);
    await assertOrgPayor(tx, v.payorId);
    const existing = await tx.clientPayor.findMany({ where: { clientId } });
    if (id && !existing.some((p) => p.id === id)) throw new HttpError(404, "Not found");
    // Exactly one primary whenever the client has insurance: every plan and rule check uses it.
    const others = existing.filter((p) => p.id !== id);
    if (v.priority === "primary" && others.some((p) => p.priority === "primary"))
      throw new HttpError(409, "This client already has a primary payor. Make it secondary first.");
    if (v.priority === "secondary" && !others.some((p) => p.priority === "primary"))
      throw new HttpError(422, "Add (or keep) a primary payor before a secondary one.");
    const row = id
      ? await tx.clientPayor.update({ where: { id }, data: v, select: { id: true } })
      : await tx.clientPayor.create({ data: { orgId: ctx.orgId, clientId, ...v }, select: { id: true } });
    await note(tx, id ? "insurance:update" : "insurance:create", "ClientPayor", row.id);
    return row;
  });
}

export async function deleteClientPayor(ctx: OrgCtx, clientId: string, id: string) {
  requirePermission(ctx.role, "insurance:manage");
  return withOrg(ctx, async (tx) => {
    const row = await tx.clientPayor.findFirst({ where: { id, clientId } });
    if (!row) throw new HttpError(404, "Not found");
    if (row.priority === "primary" && (await tx.clientPayor.count({ where: { clientId, id: { not: id } } })))
      throw new HttpError(409, "Make another payor primary before removing the primary payor.");
    await tx.clientPayor.delete({ where: { id } });
    await note(tx, "insurance:delete", "ClientPayor", id);
  });
}

/**
 * Records a benefits check on one of the client's insurances. A check that confirms how an
 * unconfirmed commercial plan is funded also sets the insurance's plan type (audit-logged);
 * Medicaid, TRICARE, and confirmed plan types are never overwritten.
 */
export async function saveBenefitsCheck(
  ctx: OrgCtx,
  clientId: string,
  clientPayorId: string,
  input: unknown,
  asOf: string = toDay(new Date()),
) {
  requirePermission(ctx.role, "insurance:manage");
  const v = BenefitsCheckSchema.parse(input);
  assertNotFuture(v.checkedOn, asOf, "The benefits check date");
  // The insurance already holds the member ID: free text never needs a name, birth date, or ID.
  if ([v.notes, v.visitOrHourLimits].some((t) => t && looksLikePhiInNote(t)))
    throw new HttpError(
      422,
      "Leave names, dates of birth, and member IDs out of the notes and limits; the insurance already holds the member ID.",
    );
  if (!ctx.userId) throw new HttpError(403, "Sign in to record a benefits check");
  const userId = ctx.userId;
  return withOrg(ctx, async (tx) => {
    const cp = await tx.clientPayor.findFirst({
      where: { id: clientPayorId, clientId },
      include: { payor: { select: { lineOfBusiness: true } } },
    });
    if (!cp) throw new HttpError(404, "Not found");
    const row = await tx.benefitsCheck.create({
      data: {
        orgId: ctx.orgId,
        clientId,
        clientPayorId: cp.id,
        payorId: cp.payorId,
        checkedByUserId: userId,
        ...v,
        checkedOn: dayToDate(v.checkedOn),
      },
      select: { id: true },
    });
    await note(tx, "benefits_check:create", "BenefitsCheck", row.id, {
      clientPayorId: cp.id,
      method: v.method,
    });
    const from = cp.planType as PlanType;
    const to = planTypeFromFunding(from, cp.payor.lineOfBusiness, v.planFunding);
    if (to) {
      await tx.clientPayor.update({ where: { id: cp.id }, data: { planType: to } });
      await note(tx, "insurance:plan_type_from_benefits_check", "ClientPayor", cp.id, {
        from,
        to,
        benefitsCheckId: row.id,
      });
    }
    return { id: row.id, planType: to ? { from, to } : null };
  });
}

// ---------------------------------------------------------------- diagnoses

export async function saveDiagnosis(
  ctx: OrgCtx,
  clientId: string,
  id: string | null,
  input: unknown,
  asOf: string = toDay(new Date()),
) {
  requirePermission(ctx.role, "client:write");
  const v = DiagnosisSchema.parse(input);
  assertNotFuture(v.evaluationDate, asOf, "The evaluation date");
  return withOrg(ctx, async (tx) => {
    await clientOf(tx, clientId);
    if (id && !(await tx.diagnosis.findFirst({ where: { id, clientId } })))
      throw new HttpError(404, "Not found");
    if (id) {
      // Goals link to a diagnosis through its deficit areas: never strand a linked goal.
      const stranded = await tx.goal.count({
        where: { diagnosisId: id, deficitArea: { notIn: v.deficitAreas } },
      });
      if (stranded)
        throw new HttpError(409, `${stranded} goal(s) are linked through a deficit area you removed`);
    }
    const all = await tx.diagnosis.findMany({ where: { clientId }, select: { id: true, isPrimary: true } });
    // Exactly one primary diagnosis: the first one is primary, and the primary moves, never disappears.
    if (!all.some((d) => d.id !== id)) v.isPrimary = true;
    else if (!v.isPrimary && all.find((d) => d.id === id)?.isPrimary)
      throw new HttpError(409, "Mark another diagnosis primary first");
    if (v.isPrimary)
      await tx.diagnosis.updateMany({
        where: { clientId, ...(id ? { id: { not: id } } : {}) },
        data: { isPrimary: false },
      });
    const data = { ...v, evaluationDate: day(v.evaluationDate) };
    const row = id
      ? await tx.diagnosis.update({ where: { id }, data, select: { id: true } })
      : await tx.diagnosis.create({ data: { orgId: ctx.orgId, clientId, ...data }, select: { id: true } });
    await note(tx, id ? "diagnosis:update" : "diagnosis:create", "Diagnosis", row.id);
    return row;
  });
}

export async function deleteDiagnosis(ctx: OrgCtx, clientId: string, id: string) {
  requirePermission(ctx.role, "client:write");
  return withOrg(ctx, async (tx) => {
    if (!(await tx.diagnosis.findFirst({ where: { id, clientId } }))) throw new HttpError(404, "Not found");
    if (await tx.goal.count({ where: { diagnosisId: id } }))
      throw new HttpError(409, "Goals are linked to this diagnosis. Relink or remove them first.");
    const row = await tx.diagnosis.findUniqueOrThrow({ where: { id } });
    await tx.diagnosis.delete({ where: { id } });
    if (row.isPrimary) {
      const next = await tx.diagnosis.findFirst({ where: { clientId }, orderBy: { icd10Code: "asc" } });
      if (next) await tx.diagnosis.update({ where: { id: next.id }, data: { isPrimary: true } });
    }
    await note(tx, "diagnosis:delete", "Diagnosis", id);
  });
}

// ---------------------------------------------------------------- authorizations

export async function saveAuthorization(ctx: OrgCtx, clientId: string, id: string | null, input: unknown) {
  requirePermission(ctx.role, "insurance:manage");
  const v = AuthorizationSchema.parse(input);
  return withOrg(ctx, async (tx) => {
    await clientOf(tx, clientId);
    await assertOrgPayor(tx, v.payorId);
    // A new authorization (or a changed payor) must come from one of the client's insurers;
    // a past authorization stays editable after its insurance was removed.
    const prior = id
      ? await tx.authorization.findFirst({ where: { id, clientId }, select: { payorId: true } })
      : null;
    if (id && !prior) throw new HttpError(404, "Not found");
    if (
      (!prior || prior.payorId !== v.payorId) &&
      !(await tx.clientPayor.count({ where: { clientId, payorId: v.payorId } }))
    )
      throw new HttpError(
        422,
        "This client has no insurance with that payor. Add the payor under Insurance first, or choose one of the client's payors.",
      );
    if (id && !(await tx.authorization.findFirst({ where: { id, clientId } })))
      throw new HttpError(404, "Not found");
    const data = {
      payorId: v.payorId,
      authNumber: v.authNumber,
      kind: v.kind,
      startDate: dayToDate(v.startDate),
      endDate: dayToDate(v.endDate),
      recommendedHoursPerWeek: v.recommendedHoursPerWeek ?? null,
    };
    let authId: string;
    if (id) {
      if (
        await tx.serviceSession.count({
          where: {
            authorizationId: id,
            OR: [{ date: { lt: data.startDate } }, { date: { gt: data.endDate } }],
          },
        })
      )
        throw new HttpError(409, "Sessions on record fall outside the new dates");
      if (
        await tx.serviceSession.count({
          where: { authorizationId: id, cptCode: { notIn: v.units.map((u) => u.cptCode) } },
        })
      )
        throw new HttpError(409, "Sessions on record use a CPT code this change removes");
      await tx.authorization.update({ where: { id }, data });
      // Units are replaced as a set.
      await tx.authorizationUnit.deleteMany({ where: { authorizationId: id } });
      authId = id;
    } else
      authId = (
        await tx.authorization.create({ data: { orgId: ctx.orgId, clientId, ...data }, select: { id: true } })
      ).id;
    await tx.authorizationUnit.createMany({
      data: v.units.map((u) => ({ orgId: ctx.orgId, authorizationId: authId, ...u })),
    });
    await note(tx, id ? "authorization:update" : "authorization:create", "Authorization", authId, {
      codes: v.units.map((u) => u.cptCode),
    });
    return { id: authId };
  });
}

export async function deleteAuthorization(ctx: OrgCtx, clientId: string, id: string) {
  requirePermission(ctx.role, "insurance:manage");
  return withOrg(ctx, async (tx) => {
    if (!(await tx.authorization.findFirst({ where: { id, clientId } })))
      throw new HttpError(404, "Not found");
    if (
      (await tx.serviceSession.count({ where: { authorizationId: id } })) ||
      (await tx.plan.count({ where: { authorizationId: id } }))
    )
      throw new HttpError(409, "Sessions or plans use this authorization; it cannot be deleted");
    await tx.authorizationUnit.deleteMany({ where: { authorizationId: id } });
    await tx.authorization.delete({ where: { id } });
    await note(tx, "authorization:delete", "Authorization", id);
  });
}

// ---------------------------------------------------------------- attachments (metadata only)

export async function saveAttachment(
  ctx: OrgCtx,
  clientId: string,
  id: string | null,
  input: unknown,
  asOf: string = toDay(new Date()),
) {
  requirePermission(ctx.role, "document:manage");
  const v = AttachmentSchema.parse(input);
  assertNotFuture(v.documentDate, asOf, "The document date");
  return withOrg(ctx, async (tx) => {
    await clientOf(tx, clientId);
    if (id && !(await tx.attachment.findFirst({ where: { id, clientId } })))
      throw new HttpError(404, "Not found");
    const data = { ...v, documentDate: day(v.documentDate) };
    const row = id
      ? await tx.attachment.update({ where: { id }, data, select: { id: true } })
      : await tx.attachment.create({ data: { orgId: ctx.orgId, clientId, ...data }, select: { id: true } });
    await note(tx, id ? "attachment:update" : "attachment:create", "Attachment", row.id, { kind: v.kind });
    return row;
  });
}

export async function deleteAttachment(ctx: OrgCtx, clientId: string, id: string) {
  requirePermission(ctx.role, "document:manage");
  return withOrg(ctx, async (tx) => {
    if (!(await tx.attachment.findFirst({ where: { id, clientId } }))) throw new HttpError(404, "Not found");
    await tx.attachment.delete({ where: { id } });
    await note(tx, "attachment:delete", "Attachment", id);
  });
}

// ---------------------------------------------------------------- sessions and goal data

export async function addSession(
  ctx: OrgCtx,
  clientId: string,
  input: unknown,
  asOf: string = toDay(new Date()),
) {
  requirePermission(ctx.role, "data:enter");
  const v = SessionSchema.parse(input);
  assertNotFuture(v.date, asOf, "The session date");
  const roles = CPT_PROVIDER_ROLES[v.cptCode];
  if (!roles.includes(v.providerRole))
    throw new HttpError(
      422,
      `${v.cptCode} must be delivered by a ${roles.join(" or ")}, not by an ${v.providerRole}`,
    );
  assertStaffCodeMatchesRole(v.providerId, v.providerRole);
  return withOrg(ctx, async (tx) => {
    const auth = await tx.authorization.findFirst({
      where: { id: v.authorizationId, clientId },
      include: { units: true },
    });
    if (!auth) throw new HttpError(422, "Choose one of this client's authorizations");
    if (!auth.units.some((u) => u.cptCode === v.cptCode))
      throw new HttpError(422, `This authorization does not approve ${v.cptCode}`);
    const date = dayToDate(v.date);
    if (date < auth.startDate || date > auth.endDate)
      throw new HttpError(422, "The session date is outside the authorization");
    const row = await tx.serviceSession.create({
      data: { orgId: ctx.orgId, clientId, ...v, providerRole: v.providerRole as Role, date },
      select: { id: true },
    });
    await note(tx, "session:create", "ServiceSession", row.id, { cptCode: v.cptCode });
    return row;
  });
}

export async function deleteSession(ctx: OrgCtx, clientId: string, id: string) {
  requirePermission(ctx.role, "data:enter");
  return withOrg(ctx, async (tx) => {
    if (!(await tx.serviceSession.findFirst({ where: { id, clientId } })))
      throw new HttpError(404, "Not found");
    await tx.serviceSession.delete({ where: { id } });
    await note(tx, "session:delete", "ServiceSession", id);
  });
}

export async function addDataPoint(
  ctx: OrgCtx,
  goalId: string,
  input: unknown,
  asOf: string = toDay(new Date()),
) {
  requirePermission(ctx.role, "data:enter");
  const v = DataPointSchema.parse(input);
  assertNotFuture(v.date, asOf, "The data point date");
  return withOrg(ctx, async (tx) => {
    const g = await tx.goal.findUnique({ where: { id: goalId } });
    if (!g) throw new HttpError(404, "Not found");
    if (g.measure === "percent" && v.value > 100)
      throw new HttpError(422, "A percent goal's value is 0 to 100");
    // Once locked, the baseline's points are the only ones on or before its date.
    if (g.baselineLockedAt && g.baselineDate && dayToDate(v.date) <= g.baselineDate)
      throw new HttpError(
        422,
        `The baseline is locked; new data must be dated after ${toDay(g.baselineDate)}`,
      );
    const row = await tx.goalDataPoint.create({
      data: { orgId: ctx.orgId, goalId, date: dayToDate(v.date), value: v.value, trials: v.trials ?? null },
      select: { id: true },
    });
    await note(tx, "goal_data:create", "GoalDataPoint", row.id, { goalId });
    return row;
  });
}

export async function deleteDataPoint(ctx: OrgCtx, goalId: string, id: string) {
  requirePermission(ctx.role, "data:enter");
  return withOrg(ctx, async (tx) => {
    const p = await tx.goalDataPoint.findFirst({ where: { id, goalId } });
    if (!p) throw new HttpError(404, "Not found");
    // A locked baseline came from the first three points; those stay.
    const g = await tx.goal.findUniqueOrThrow({ where: { id: goalId } });
    if (g.baselineLockedAt && g.baselineDate && p.date <= g.baselineDate)
      throw new HttpError(409, "This data point is part of the locked baseline");
    await tx.goalDataPoint.delete({ where: { id } });
    await note(tx, "goal_data:delete", "GoalDataPoint", id, { goalId });
  });
}

// ---------------------------------------------------------------- practice settings

export async function practiceSettings(ctx: OrgCtx) {
  requirePermission(ctx.role, "org:manage");
  return withOrg(ctx, async (tx) => {
    const org = await tx.org.findUniqueOrThrow({ where: { id: ctx.orgId } });
    // RLS also shows the caller's own memberships elsewhere (for sign-in): scope to this practice.
    const members = await tx.membership.findMany({
      where: { orgId: ctx.orgId },
      include: { user: true },
      orderBy: { role: "asc" },
    });
    return {
      org,
      members: members.map((m) => ({
        id: m.id,
        userId: m.userId,
        role: m.role,
        name: m.user.name,
        email: m.user.email,
        mfaEnabled: m.user.mfaEnabled,
      })),
    };
  });
}

export async function updateSettings(ctx: OrgCtx, input: unknown) {
  requirePermission(ctx.role, "org:manage");
  const v = SettingsSchema.parse(input);
  return withOrg(ctx, async (tx) => {
    const org = await tx.org.findUniqueOrThrow({ where: { id: ctx.orgId } });
    const { name, ...given } = v;
    // Leave out what was not sent (e.g. statesServed from an older client), so it is kept too.
    const rest = Object.fromEntries(Object.entries(given).filter(([, x]) => x !== undefined));
    // Merge: keys this form does not edit (e.g. seededAsOf, alertDays) are kept.
    await tx.org.update({
      where: { id: ctx.orgId },
      data: { name, settings: { ...(org.settings as object), ...rest } as Prisma.InputJsonValue },
    });
    await note(tx, "org:settings_update", "Org", ctx.orgId, { fields: Object.keys(v) });
  });
}

// ---------------------------------------------------------------- team members

async function assertKeepsABcba(tx: Tx, orgId: string, membershipId: string) {
  const bcbas = await tx.membership.findMany({ where: { orgId, role: "BCBA" }, select: { id: true } });
  if (bcbas.length === 1 && bcbas[0]!.id === membershipId)
    throw new HttpError(409, "The practice needs at least one BCBA");
}

export async function addMember(ctx: OrgCtx, input: unknown) {
  requirePermission(ctx.role, "org:manage");
  const v = NewMemberSchema.parse(input);
  return withOrg(ctx, async (tx) => {
    // Accounts belong to one practice in v1.0; never attach someone else's account here.
    const existing = await tx.user.findUnique({ where: { email: v.email }, select: { id: true } });
    let user: { id: string };
    if (existing) {
      // An account that belongs to no practice any more (removed earlier) can be re-added, with a fresh
      // password and authenticator. Its memberships are visible only as that user.
      const memberships = await withUser(existing.id, (u) =>
        u.membership.count({ where: { userId: existing.id } }),
      );
      if (memberships) throw new HttpError(409, "An account with that email already exists");
      user = await tx.user.update({
        where: { id: existing.id },
        data: {
          name: v.name,
          passwordHash: hashPassword(v.password),
          totpSecret: null,
          mfaEnabled: false,
          failedMfaCount: 0,
          mfaLockedUntil: null,
        },
        select: { id: true },
      });
      await tx.authSession.deleteMany({ where: { userId: existing.id } });
    } else
      user = await tx.user.create({
        data: { email: v.email, name: v.name, passwordHash: hashPassword(v.password), mfaEnabled: false },
        select: { id: true },
      });
    const m = await tx.membership.create({
      data: { orgId: ctx.orgId, userId: user.id, role: v.role },
      select: { id: true },
    });
    await note(tx, "member:add", "Membership", m.id, { role: v.role });
    return m;
  });
}

export async function changeMemberRole(ctx: OrgCtx, membershipId: string, role: unknown) {
  requirePermission(ctx.role, "org:manage");
  const r = z.enum(MEMBER_ROLES).parse(role);
  return withOrg(ctx, async (tx) => {
    const m = await tx.membership.findFirst({ where: { id: membershipId, orgId: ctx.orgId } });
    if (!m) throw new HttpError(404, "Not found");
    if (m.userId === ctx.userId) throw new HttpError(409, "You cannot change your own role");
    // Parent accounts are linked to their own child's documents, never staff.
    if (m.role === "PARENT") throw new HttpError(409, "A parent account cannot be given a staff role");
    if (m.role === "BCBA" && r !== "BCBA") await assertKeepsABcba(tx, ctx.orgId, m.id);
    await tx.membership.update({ where: { id: m.id }, data: { role: r } });
    // The person's open sessions carry the old role: sign them out.
    await tx.authSession.deleteMany({ where: { userId: m.userId, orgId: ctx.orgId } });
    await note(tx, "member:role", "Membership", m.id, { from: m.role, to: r });
  });
}

export async function removeMember(ctx: OrgCtx, membershipId: string) {
  requirePermission(ctx.role, "org:manage");
  return withOrg(ctx, async (tx) => {
    const m = await tx.membership.findFirst({ where: { id: membershipId, orgId: ctx.orgId } });
    if (!m) throw new HttpError(404, "Not found");
    if (m.userId === ctx.userId) throw new HttpError(409, "You cannot remove yourself");
    await assertKeepsABcba(tx, ctx.orgId, m.id);
    await tx.membership.delete({ where: { id: m.id } });
    await tx.authSession.deleteMany({ where: { userId: m.userId, orgId: ctx.orgId } });
    await note(tx, "member:remove", "Membership", m.id, { role: m.role });
  });
}

// ---------------------------------------------------------------- read for the records page

export async function clientRecords(ctx: OrgCtx, clientId: string) {
  requirePermission(ctx.role, "client:read");
  return withOrg(ctx, async (tx) => {
    const client = await tx.client.findUnique({
      where: { id: clientId },
      include: {
        payors: {
          include: {
            payor: true,
            // For "Benefits last checked" on each insurance (narrowed to its current payor below).
            benefitsChecks: { orderBy: [{ checkedOn: "desc" }, { createdAt: "desc" }] },
          },
          orderBy: { priority: "asc" },
        },
        diagnoses: { orderBy: [{ isPrimary: "desc" }, { icd10Code: "asc" }] },
        authorizations: { include: { units: true, payor: true }, orderBy: { endDate: "desc" } },
        attachments: { orderBy: { uploadedAt: "desc" } },
      },
    });
    if (!client) throw new HttpError(404, "Not found");
    registerSensitiveName(client.firstName);
    registerSensitiveName(client.lastName);
    // The latest check for the payor each row has now (a row's payor can be changed).
    for (const p of client.payors) p.benefitsChecks = checksForInsurance(p.benefitsChecks, p).slice(0, 1);
    const sessions = await tx.serviceSession.findMany({
      where: { clientId },
      orderBy: [{ date: "desc" }, { startMinute: "desc" }],
      take: 60,
    });
    const payors = await tx.payor.findMany({
      orderBy: { name: "asc" },
      select: { id: true, name: true, states: true },
    });
    return { client, sessions, payors };
  });
}
