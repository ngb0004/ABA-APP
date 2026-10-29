import { NextResponse } from "next/server";
import { ZodError } from "zod";
import { ctxFromRequest } from "../auth/session";
import type { OrgCtx } from "../db";
import { HttpError, log } from "../log";

type Handler<P> = (req: Request, ctx: OrgCtx, params: P) => Promise<Response | unknown>;

/**
 * Wraps a route handler: authenticates (password + MFA + org), rejects
 * cross-origin mutations, and maps errors to JSON without leaking details.
 */
export function api<P = Record<string, string>>(fn: Handler<P>) {
  return async (req: Request, route: { params: Promise<P> }) => {
    try {
      if (req.method !== "GET" && req.method !== "HEAD") assertSameOrigin(req);
      const ctx = await ctxFromRequest(req);
      const out = await fn(req, ctx, await route.params);
      return out instanceof Response ? out : NextResponse.json(out ?? { ok: true });
    } catch (e) {
      return errorResponse(e);
    }
  };
}

export function assertSameOrigin(req: Request) {
  const origin = req.headers.get("origin");
  if (!origin) return;
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host");
  if (new URL(origin).host !== host) throw new HttpError(403, "Cross-origin request rejected");
}

export function errorResponse(e: unknown) {
  if (e instanceof HttpError) return NextResponse.json({ error: e.message }, { status: e.status });
  if (e instanceof ZodError)
    return NextResponse.json(
      { error: "Invalid request", issues: e.issues.map((i) => `${i.path.join(".")}: ${i.message}`) },
      { status: 400 },
    );
  if (e instanceof Error && e.name === "AiFirewallError")
    return NextResponse.json({ error: e.message }, { status: 422 });
  if (e instanceof Error && /Record to update not found|No .* found/.test(e.message))
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  // Never echo internal errors: they can contain query data.
  log.error("Unhandled API error", { name: e instanceof Error ? e.name : typeof e });
  return NextResponse.json({ error: "Something went wrong" }, { status: 500 });
}

export async function readJson<T>(req: Request, schema: { parse: (x: unknown) => T }): Promise<T> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    throw new HttpError(400, "Expected a JSON body");
  }
  return schema.parse(body);
}

export async function readUpload(
  req: Request,
  maxBytes: number,
): Promise<{ filename: string; data: Buffer }> {
  const form = await req.formData();
  const file = form.get("file");
  if (!(file instanceof File)) throw new HttpError(400, "No file uploaded");
  if (file.size > maxBytes) throw new HttpError(413, "File too large");
  return { filename: file.name, data: Buffer.from(await file.arrayBuffer()) };
}
