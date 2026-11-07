import { inspect } from "node:util";
import { scrub } from "../log";

let installed = false;

/** One console argument as scrubbed text (errors keep their name, message and stack, scrubbed). */
export function scrubArg(a: unknown): string {
  if (typeof a === "string") return scrub(a);
  return scrub(inspect(a, { depth: 4, breakLength: Infinity }));
}

/**
 * Next.js prints errors from server components, route handlers outside api(), and its own
 * rendering with console.error, message and stack included, which would bypass src/lib/log.ts.
 * Installed once at server start (src/instrumentation.ts) so every console line is scrubbed too.
 */
export function installConsoleScrub() {
  if (installed) return;
  installed = true;
  for (const level of ["error", "warn", "log", "info"] as const) {
    const original = console[level].bind(console);
    console[level] = (...args: unknown[]) => original(args.map(scrubArg).join(" "));
  }
}
