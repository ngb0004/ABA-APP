import { HttpError } from "../log";

/**
 * True for errors that mean "no such record (in this org)": an HttpError 404
 * from a service, or Prisma's findUniqueOrThrow/findFirstOrThrow/update miss
 * (code P2025). Row-level security hides other orgs' rows, so those land here too.
 */
export function isNotFoundError(e: unknown): boolean {
  if (e instanceof HttpError) return e.status === 404;
  if (!(e instanceof Error)) return false;
  if ((e as { code?: unknown }).code === "P2025") return true;
  return e.name === "NotFoundError" || /^No .* found/.test(e.message);
}

/** Runs a page's record loader; a missing record becomes `onNotFound()` (Next's notFound() in pages). */
export async function loadOr404<T>(load: () => Promise<T>, onNotFound: () => never): Promise<T> {
  try {
    return await load();
  } catch (e) {
    if (isNotFoundError(e)) onNotFound();
    throw e;
  }
}
