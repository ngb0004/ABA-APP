/**
 * Server start-up hooks (Next.js instrumentation).
 * - register(): checks the configuration (src/lib/env.ts refuses unsafe production settings) and
 *   routes every console line through the PHI scrubber.
 * - onRequestError(): errors thrown outside api() (server components, pages) are logged through
 *   src/lib/log.ts as name, digest and route only; a refused page (403) is audited like an API one.
 */
type RequestInfo = { path: string; method: string; headers: Record<string, string | string[] | undefined> };

export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { installConsoleScrub } = await import("./lib/server/console-scrub");
  installConsoleScrub();
  const { env } = await import("./lib/env");
  env();
}

export async function onRequestError(err: unknown, request: RequestInfo) {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { reportRequestError } = await import("./lib/server/request-error");
  await reportRequestError(err, request);
}
