import type { Role } from "@prisma/client";
import { can } from "./permissions";

export type Sensitivity = "normal" | "sensitive" | "restricted";

/** Field-level tags for model columns. Intake fields carry their own tags in the intake schema. */
export const FIELD_SENSITIVITY: Record<string, Record<string, Sensitivity>> = {
  Client: {
    firstName: "sensitive",
    lastName: "sensitive",
    dob: "sensitive",
    serviceAddress: "sensitive",
    guardians: "sensitive",
  },
  ClientPayor: { memberId: "sensitive" },
};

/** Drop restricted keys for roles that may not see them (BCBA only). */
export function redactRestricted<T extends Record<string, unknown>>(
  values: T,
  sensitivityOf: (key: string) => Sensitivity,
  role: Role | null | undefined,
): Partial<T> {
  if (can(role, "client:read_restricted")) return values;
  const out: Partial<T> = {};
  for (const [k, v] of Object.entries(values)) {
    if (sensitivityOf(k) !== "restricted") (out as Record<string, unknown>)[k] = v;
  }
  return out;
}
