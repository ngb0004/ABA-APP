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
  return withOrg(ctx, async (tx) => {
    const c = await tx.client.findUnique({
      where: { id: clientId },
      select: { status: true, inactiveSince: true, inactiveReason: true, inactiveNote: true },
    });
    if (!c) throw new HttpError(404, "Not found");
    if (v.status === "inactive") {
      if (c.status === "inactive") throw new HttpError(409, "This client is already inactive");
      const first = await earliestRecord(tx, clientId);
      if (first && v.date < first)
        throw new HttpError(
          422,
          "The inactive date cannot be before the client's first authorization or session",
        );
      await tx.client.update({
        where: { id: clientId },
        data: {
          status: "inactive",
          inactiveSince: dayToDate(v.date),
          inactiveReason: v.reason,
          inactiveNote: v.note,
        },
      });
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
    await tx.client.update({
      where: { id: clientId },
      data: { status: "active", inactiveSince: null, inactiveReason: null, inactiveNote: null },
    });
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

/** New records (and changes to drafts) wait until an inactive client is reactivated. */
export async function assertClientActive(tx: Tx, clientId: string): Promise<void> {
  const c = await tx.client.findUnique({ where: { id: clientId }, select: { status: true } });
  if (!c) throw new HttpError(404, "Not found");
  if (c.status === "inactive") throw new HttpError(409, CLIENT_INACTIVE_MESSAGE);
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
