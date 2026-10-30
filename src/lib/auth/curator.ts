/**
 * Platform curators: Yoma staff who keep the payor rule library correct (verify rules
 * against the official documents, review problem reports). This is not an org role.
 * The flag is set only by scripts/set-curator.ts, connected as the table owner: a trigger
 * rejects the app role changing it (see the curator_and_rule_reports migration).
 */
import type { PrismaClient } from "@prisma/client";
import { z } from "zod";
import { db, type OrgCtx } from "../db";
import { HttpError } from "../log";

export const CURATOR_ONLY_MESSAGE =
  'Only Yoma\'s rule reviewers can do this. Use "Report a problem" if a rule looks wrong.';

/** True when the signed-in user is a platform curator. Read fresh from the user row, never from a cookie. */
export async function isPlatformCurator(ctx: Pick<OrgCtx, "userId">): Promise<boolean> {
  if (!ctx.userId) return false;
  const u = await db().user.findUnique({ where: { id: ctx.userId }, select: { isPlatformCurator: true } });
  return !!u?.isPlatformCurator;
}

/** 403 unless the signed-in user is a platform curator. Org role checks still apply on top. */
export async function requireCurator(ctx: Pick<OrgCtx, "userId">): Promise<void> {
  if (!(await isPlatformCurator(ctx))) throw new HttpError(403, CURATOR_ONLY_MESSAGE);
}

const Email = z.string().trim().toLowerCase().email().max(254);

export type SetCuratorResult = {
  userId: string;
  email: string;
  isPlatformCurator: boolean;
  changed: boolean;
};

/**
 * Grant or revoke the curator flag for one account, and audit-log the change. `owner` must be
 * a client connected as the table owner (DIRECT_DATABASE_URL); the database rejects the app role.
 * The audit row is org-less (a platform event) and holds the user id only, never the email.
 */
export async function setPlatformCurator(
  owner: Pick<PrismaClient, "$transaction">,
  emailInput: string,
  grant: boolean,
  actor = "cli",
): Promise<SetCuratorResult> {
  const email = Email.parse(emailInput);
  return owner.$transaction(async (tx) => {
    const user = await tx.user.findUnique({
      where: { email },
      select: { id: true, isPlatformCurator: true },
    });
    if (!user) throw new HttpError(404, "No account with that email");
    const changed = user.isPlatformCurator !== grant;
    if (changed) await tx.user.update({ where: { id: user.id }, data: { isPlatformCurator: grant } });
    await tx.auditEvent.createMany({
      data: {
        orgId: null,
        userId: null,
        action: grant ? "curator:grant" : "curator:revoke",
        entityType: "User",
        entityId: user.id,
        meta: { changed, actor: actor.slice(0, 64) },
      },
    });
    return { userId: user.id, email, isPlatformCurator: grant, changed };
  });
}

/** Parses `set-curator <email> [--revoke]`. */
export function parseSetCuratorArgs(argv: string[]): { email: string; grant: boolean } {
  const flags = argv.filter((a) => a.startsWith("--"));
  const rest = argv.filter((a) => !a.startsWith("--"));
  const unknown = flags.filter((f) => f !== "--revoke");
  if (unknown.length) throw new Error(`Unknown option ${unknown[0]}`);
  if (rest.length !== 1) throw new Error("Usage: pnpm curator:set <email> [--revoke]");
  return { email: Email.parse(rest[0]), grant: !flags.includes("--revoke") };
}
