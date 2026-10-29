import { createHash } from "node:crypto";

/** Deterministic UUID (v5-shaped) from a name, so re-running a sync or seed produces identical IDs. */
export function sid(name: string): string {
  const h = createHash("sha1").update(`aba-synthetic:${name}`).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-${((parseInt(h.slice(16, 18), 16) & 0x3f) | 0x80).toString(16)}${h.slice(18, 20)}-${h.slice(20, 32)}`;
}
