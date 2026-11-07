/**
 * Application logger. Rule 4: no PHI in application logs or error messages.
 * Every message passes through scrub(), which removes anything shaped like a
 * member ID, date, email, or a registered client name before it is written.
 */
const registeredNames = new Set<string>();

/** Client names are registered when loaded so they can be scrubbed from logs. */
export function registerSensitiveName(name: string | null | undefined) {
  if (name && name.trim().length >= 2) registeredNames.add(name.trim());
}

/** Every name on a client record: first, last, preferred, and each guardian's (whole and in parts). */
export function registerClientNames(c: {
  firstName?: string | null;
  lastName?: string | null;
  preferredName?: string | null;
  guardians?: unknown;
}) {
  registerSensitiveName(c.firstName);
  registerSensitiveName(c.lastName);
  registerSensitiveName(c.preferredName);
  for (const g of Array.isArray(c.guardians) ? (c.guardians as { name?: unknown }[]) : [])
    if (typeof g?.name === "string") {
      registerSensitiveName(g.name);
      for (const part of g.name.split(/\s+/)) if (part.length >= 3) registerSensitiveName(part);
    }
}

export function scrub(input: string): string {
  let out = input
    .replace(/\b\d{3}-\d{2}-\d{4}\b/g, "[ssn]")
    .replace(/(?<!\d)(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}(?!\d)/g, "[phone]")
    .replace(
      /\b\d+\s+[A-Z][a-z]+(?:\s+[A-Z][a-z]+)*\s+(?:St|Street|Ave|Avenue|Rd|Road|Dr|Drive|Ln|Lane|Blvd|Ct|Court|Way|Pl|Place|Pkwy|Cir)\b\.?/g,
      "[address]",
    )
    .replace(/\b\d{5}(?:-\d{4})?\b/g, "[zip]")
    .replace(/\bSYN-[A-Z0-9-]+\b/gi, "[member-id]")
    .replace(/\b[A-Z]{2,4}\d{6,}\b/g, "[member-id]")
    .replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, "[email]")
    .replace(/\b\d{1,2}\/\d{1,2}\/\d{2,4}\b/g, "[date]")
    .replace(/\b\d{4}-\d{2}-\d{2}\b/g, "[date]");
  for (const name of registeredNames) {
    out = out.split(name).join("[name]");
  }
  return out;
}

type Sink = (line: string) => void;
let sink: Sink = (line) => process.stderr.write(line + "\n");

/** Tests swap the sink to capture output. */
export function setLogSink(s: Sink) {
  sink = s;
}

function emit(level: string, message: string, meta?: Record<string, unknown>) {
  const body = meta ? `${message} ${JSON.stringify(meta)}` : message;
  sink(scrub(`[${level}] ${body}`));
}

export const log = {
  info: (m: string, meta?: Record<string, unknown>) => emit("info", m, meta),
  warn: (m: string, meta?: Record<string, unknown>) => emit("warn", m, meta),
  error: (m: string, meta?: Record<string, unknown>) => emit("error", m, meta),
};

/** Error with a status and a PHI-free public message. */
export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
    /** Plain sentences, one per problem, shown under the message (never PHI). */
    public issues?: string[],
    /** More for the client (e.g. a conflict's current values). Sent in the response, never logged. */
    public data?: Record<string, unknown>,
  ) {
    super(message);
  }
}
export class ForbiddenError extends HttpError {
  constructor(action: string) {
    super(403, `Forbidden: ${action}`);
  }
}
