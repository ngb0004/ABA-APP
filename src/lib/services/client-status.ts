/**
 * Marking a client inactive (discontinued) or active again. BCBA only. Inactive clients drop out of
 * the caseload's alerts and due dates and take no new records; nothing is deleted, and every record
 * stays readable. The audit log keeps the history: the reason code and dates, never the note's text.
 */
import { z } from "zod";
import { audit, sha256 } from "../audit";
import {
  CLIENT_INACTIVE_MESSAGE,
  INACTIVE_NOTE_MAX,
  INACTIVE_REASONS,
  type InactiveReason,
} from "../client-status";
import { withOrg, type OrgCtx, type Tx } from "../db";
import { addDays, dayToDate, toDay, type Day } from "../dates";
import { HttpError } from "../log";
import { requirePermission } from "../permissions";
import { FUTURE_TOLERANCE_DAYS } from "../assessments/validate";
import { looksLikePhiInNote } from "../rules-watch/text";

const DaySchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Use a date (YYYY-MM-DD)")
  .refine((s) => {
    const d = dayToDate(s);
    return !Number.isNaN(d.getTime()) && toDay(d) === s;
  }, "Not a real calendar date");

export const ClientStatusInput = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("inactive"),
    date: DaySchema,
    reason: z.enum(INACTIVE_REASONS, "Choose a reason"),
    note: z
      .string()
      .trim()
      .max(INACTIVE_NOTE_MAX, `Keep the note to ${INACTIVE_NOTE_MAX} characters or fewer`)
      .nullish()
      .transform((v) => (v ? v : null)),
  }),
  z.object({ status: z.literal("active") }),
]);
export type ClientStatusInput = z.input<typeof ClientStatusInput>;

/** The first day anything was recorded for the client: an authorization's start or a session. */
async function earliestRecord(tx: Tx, clientId: string): Promise<Day | null> {
  const [auth, session] = await Promise.all([
    tx.authorization.findFirst({
      where: { clientId },
      orderBy: { startDate: "asc" },
      select: { startDate: true },
    }),
    tx.serviceSession.findFirst({ where: { clientId }, orderBy: { date: "asc" }, select: { date: true } }),
  ]);
  const days = [auth?.startDate, session?.date].filter((d): d is Date => !!d).map(toDay);
  return days.length ? days.sort()[0]! : null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function setClientStatus(ctx: OrgCtx, clientId: string, input: unknown, asOf: Day) {
  requirePermission(ctx.role, "client:status");
  const v = ClientStatusInput.parse(input);
  if (v.status === "inactive") {
    if (v.date > addDays(asOf, FUTURE_TOLERANCE_DAYS))
      throw new HttpError(422, `The inactive date cannot be in the future (today is ${asOf})`);
    if (v.note && looksLikePhiInNote(v.note))
      throw new HttpError(422, "Leave names, dates of birth, and member IDs out of the note");
    if (v.note && /\{\{|\}\}/.test(v.note))
      throw new HttpError(422, "Write the note in your own words, without value references");
  }
  if (!UUID.test(clientId)) throw new HttpError(404, "Not found");
  return withOrg(ctx, async (tx) => {
    // Lock the row first: a second, concurrent status change waits here and then sees this one, and
    // a write guarded by assertClientActive (FOR SHARE) either commits before this or sees the result.
    await lockClient(tx, clientId, "update");
    const c = await tx.client.findUnique({
      where: { id: clientId },
      select: { status: true, inactiveSince: true, inactiveReason: true, inactiveNote: true, dob: true },
    });
    if (!c) throw new HttpError(404, "Not found");
    if (v.status === "inactive") {
      if (c.status === "inactive") throw new HttpError(409, "This client is already inactive");
      if (v.date < toDay(c.dob))
        throw new HttpError(422, "The inactive date cannot be before the client's date of birth");
      const first = await earliestRecord(tx, clientId);
      if (first && v.date < first)
        throw new HttpError(
          422,
          "The inactive date cannot be before the client's first authorization or session",
        );
      // Conditional as well as locked, so a status change never applies twice.
      const changed = await tx.client.updateMany({
        where: { id: clientId, status: "active" },
        data: {
          status: "inactive",
          inactiveSince: dayToDate(v.date),
          inactiveReason: v.reason,
          inactiveNote: v.note,
        },
      });
      if (changed.count === 0) throw new HttpError(409, "This client is already inactive");
      // The reason code and date only: the note is free text and stays out of the log.
      await audit(tx, {
        action: "client:inactivate",
        entityType: "Client",
        entityId: clientId,
        meta: { reason: v.reason, inactiveSince: v.date, hasNote: !!v.note },
      });
      return { status: "inactive" as const };
    }
    if (c.status !== "inactive") throw new HttpError(409, "This client is already active");
    const changed = await tx.client.updateMany({
      where: { id: clientId, status: "inactive" },
      data: { status: "active", inactiveSince: null, inactiveReason: null, inactiveNote: null },
    });
    if (changed.count === 0) throw new HttpError(409, "This client is already active");
    // What was cleared, so the history can be reconstructed (the note as a hash only).
    await audit(tx, {
      action: "client:reactivate",
      entityType: "Client",
      entityId: clientId,
      meta: {
        previousReason: c.inactiveReason as InactiveReason | null,
        inactiveSince: c.inactiveSince ? toDay(c.inactiveSince) : null,
        noteHash: c.inactiveNote ? sha256(c.inactiveNote) : null,
      },
    });
    return { status: "active" as const };
  });
}

// ---------------------------------------------------------------- write guards

/**
 * Reads the client's status with a row lock (RLS still applies: another practice's client reads as
 * missing). FOR SHARE in write guards conflicts with the FOR UPDATE / UPDATE in setClientStatus, so an
 * inactivation waits for in-flight guarded writes to commit, and a write that starts after it sees it.
 * Concurrent guarded writes share the lock and do not block each other.
 */
async function lockClient(tx: Tx, clientId: string, mode: "share" | "update"): Promise<string | null> {
  const rows =
    mode === "update"
      ? await tx.$queryRaw<
          { status: string }[]
        >`SELECT status FROM "client" WHERE id = ${clientId}::uuid FOR UPDATE`
      : await tx.$queryRaw<
          { status: string }[]
        >`SELECT status FROM "client" WHERE id = ${clientId}::uuid FOR SHARE`;
  return rows[0]?.status ?? null;
}

/** New records (and changes to drafts) wait until an inactive client is reactivated. */
export async function assertClientActive(tx: Tx, clientId: string): Promise<void> {
  if (!UUID.test(clientId)) throw new HttpError(404, "Not found");
  const status = await lockClient(tx, clientId, "share");
  if (status === null) throw new HttpError(404, "Not found");
  if (status === "inactive") throw new HttpError(409, CLIENT_INACTIVE_MESSAGE);
}

/**
 * A quick check before slow work (file extraction, OCR, workbook parsing), so an upload to an inactive
 * client is refused up front. The check inside the write transaction stays the authoritative one.
 */
export async function precheckClientActive(ctx: OrgCtx, clientId: string): Promise<void> {
  await withOrg(ctx, (tx) => assertClientActive(tx, clientId));
}

export async function assertPlanClientActive(tx: Tx, planId: string): Promise<void> {
  const p = await tx.plan.findUnique({ where: { id: planId }, select: { clientId: true } });
  if (!p) throw new HttpError(404, "Not found");
  await assertClientActive(tx, p.clientId);
}

export async function assertGoalClientActive(tx: Tx, goalId: string): Promise<void> {
  const g = await tx.goal.findUnique({ where: { id: goalId }, select: { clientId: true } });
  if (!g) throw new HttpError(404, "Not found");
  await assertClientActive(tx, g.clientId);
}

/** The status fields a page needs for the inactive banner (any role that may read the client). */
export async function clientStatusSummary(ctx: OrgCtx, clientId: string) {
  requirePermission(ctx.role, "client:read");
  return withOrg(ctx, async (tx) => {
    const c = await tx.client.findUnique({
      where: { id: clientId },
      select: { status: true, inactiveSince: true, inactiveReason: true, inactiveNote: true },
    });
    if (!c) throw new HttpError(404, "Not found");
    return c;
  });
}
