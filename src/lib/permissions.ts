import type { Role } from "@prisma/client";
import { ForbiddenError } from "./log";

/**
 * The permission matrix: role × action, in one place.
 * Only BCBA can approve, sign, or finalize. RBT enters data only. The auth
 * coordinator handles documents and packets only. A parent signs assigned
 * documents only.
 */
export const ACTIONS = [
  "client:read",
  "client:write",
  /** Mark a client inactive (discontinued) or active again. */
  "client:status",
  "client:read_restricted",
  "data:enter",
  "intake:write",
  "vbmapp:import",
  "vbmapp:confirm",
  /** Enter or edit a draft assessment of any type (same roles as importing a VB-MAPP). */
  "assessment:write",
  /** Confirm an assessment's scores (same roles as confirming a VB-MAPP import). */
  "assessment:confirm",
  "goal:write",
  "goal:approve",
  "plan:create",
  "section:draft",
  "section:edit",
  "section:approve",
  "plan:sign",
  "plan:finalize",
  "document:manage",
  "packet:manage",
  "letter:upload",
  "letter:confirm",
  "document:sign_assigned",
  "payor:read",
  "payor:verify",
  "audit:read",
  /** Insurance and authorizations on a client. */
  "insurance:manage",
  /** Practice settings and team members. */
  "org:manage",
  "export:pdf",
] as const;
export type Action = (typeof ACTIONS)[number];

export const PERMISSIONS: Record<Role, readonly Action[]> = {
  BCBA: ACTIONS.filter((a) => a !== "document:sign_assigned"),
  // BCaBA scope is an open question (docs/QUESTIONS_FOR_BCBA.md). Safest default:
  // may read and enter data, may not approve/sign/finalize or see restricted fields.
  BCaBA: ["client:read", "data:enter", "payor:read"],
  RBT: ["client:read", "data:enter"],
  AUTH_COORDINATOR: [
    "client:read",
    "document:manage",
    "insurance:manage",
    "packet:manage",
    "letter:upload",
    "payor:read",
    "export:pdf",
  ],
  PARENT: ["document:sign_assigned"],
};

export function can(role: Role | null | undefined, action: Action): boolean {
  return !!role && PERMISSIONS[role].includes(action);
}

export function requirePermission(role: Role | null | undefined, action: Action): void {
  if (!can(role, action)) throw new ForbiddenError(action);
}
