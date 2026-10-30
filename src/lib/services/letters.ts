/**
 * Payor letters: extract text, classify with the AI, and extract fields as
 * verbatim quotes. The code (not the model) verifies each quote appears in the
 * letter and parses dates/units from it, so no figure comes from the AI.
 */
import type { Prisma } from "@prisma/client";
import { z } from "zod";
import { completeJson } from "../ai";
import { audit } from "../audit";
import { withOrg, type OrgCtx } from "../db";
import { toDay } from "../dates";
import { pseudonymNames, pseudonymize } from "../intake/derive";
import { assertDemoUploadAllowed } from "../demo";
import { HttpError } from "../log";
import { requirePermission } from "../permissions";
import { assertClientActive, precheckClientActive } from "./client-status";

export const LETTER_CLASSES = ["approval", "denial", "reduction", "request_for_info", "p2p_offer"] as const;
const MAX_BYTES = 5 * 1024 * 1024;

export async function extractLetterText(filename: string, data: Buffer): Promise<string> {
  if (data.length > MAX_BYTES) throw new HttpError(413, "Letter too large (5 MB max)");
  const lower = filename.toLowerCase();
  if (lower.endsWith(".txt")) return data.toString("utf8");
  if (lower.endsWith(".pdf")) {
    if (data.subarray(0, 5).toString() !== "%PDF-") throw new HttpError(400, "Not a PDF file");
    const { extractText, getDocumentProxy } = await import("unpdf");
    const pdf = await getDocumentProxy(new Uint8Array(data));
    const { text } = await extractText(pdf, { mergePages: true });
    return text;
  }
  throw new HttpError(400, "Upload a .pdf or .txt letter");
}

const AiLetterSchema = z.object({
  classification: z.enum(LETTER_CLASSES),
  quotes: z.array(z.object({ field: z.string(), quote: z.string() })).default([]),
  requirements: z.array(z.string()).default([]),
});

export type ExtractedField = {
  field: string;
  quote: string;
  value: string | number | null;
  basis?: string;
  verified: boolean;
};

const norm = (s: string) => s.replace(/\s+/g, " ").trim();

function parseUsDate(s: string): string | null {
  const m = /(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(s);
  if (!m) return null;
  const d = new Date(Date.UTC(Number(m[3]), Number(m[1]) - 1, Number(m[2])));
  return d.getUTCMonth() === Number(m[1]) - 1 ? toDay(d) : null;
}

/** Parse a value out of a verified quote. Code does the parsing; the AI only points at the text. */
export function parseQuote(field: string, quote: string): Pick<ExtractedField, "value" | "basis"> {
  if (field === "start_date" || field === "end_date") return { value: parseUsDate(quote) };
  if (field.startsWith("units.")) {
    const m = /(\d+)\s+units/i.exec(quote);
    const basis = /per\s+week|weekly/i.test(quote)
      ? "week"
      : /per\s+month|monthly/i.test(quote)
        ? "month"
        : "auth";
    return { value: m ? Number(m[1]) : null, basis };
  }
  if (field === "auth_number") return { value: /([A-Z0-9][A-Z0-9-]{3,})\s*$/.exec(quote)?.[1] ?? null };
  if (field === "deadline")
    return { value: parseUsDate(quote) ?? /(\d+)\s+(?:business\s+)?days/i.exec(quote)?.[0] ?? null };
  return { value: null };
}

export function verifyExtraction(
  letterText: string,
  quotes: { field: string; quote: string }[],
): ExtractedField[] {
  const hay = norm(letterText);
  return quotes.map((q) => {
    const verified = q.quote.trim().length > 0 && hay.includes(norm(q.quote));
    return {
      field: q.field,
      quote: q.quote,
      verified,
      ...(verified ? parseQuote(q.field, q.quote) : { value: null }),
    };
  });
}

const SYSTEM = `You read a health-plan letter about ABA services and return JSON only, no prose:
{"classification": one of ${LETTER_CLASSES.map((c) => `"${c}"`).join(", ")},
 "quotes": [{"field": "start_date" | "end_date" | "auth_number" | "deadline" | "units.<CPT code>", "quote": "<exact text copied from the letter>"}],
 "requirements": ["<each requirement the letter lists for the next request, copied or closely paraphrased>"]}
Every quote must be copied character-for-character from the letter. Do not compute, convert, or restate any number outside a quote.`;

export async function uploadLetter(ctx: OrgCtx, clientId: string, filename: string, data: Buffer) {
  requirePermission(ctx.role, "letter:upload");
  assertDemoUploadAllowed(data);
  // Refuse an inactive client before the slow read, not after it.
  await precheckClientActive(ctx, clientId);
  const text = await extractLetterText(filename, data);
  return withOrg(ctx, async (tx) => {
    await assertClientActive(tx, clientId);
    const client = await tx.client.findUniqueOrThrow({
      where: { id: clientId },
      include: { payors: true, authorizations: { orderBy: { endDate: "desc" }, take: 1 } },
    });
    const names = pseudonymNames(client);
    // Minimum necessary: names pseudonymized, member IDs and DOB removed before the AI sees the letter.
    let safe = pseudonymize(text, names);
    for (const p of client.payors) safe = safe.split(p.memberId).join("[member-id]");
    const dob = toDay(client.dob);
    for (const v of [dob, `${dob.slice(5, 7)}/${dob.slice(8, 10)}/${dob.slice(0, 4)}`])
      safe = safe.split(v).join("[dob]");
    const letter = await tx.payorLetter.create({
      data: {
        orgId: ctx.orgId,
        clientId,
        authorizationId: client.authorizations[0]?.id ?? null,
        filename: filename.slice(0, 200),
        text,
      },
    });
    const { json } = await completeJson(tx, {
      system: SYSTEM,
      payload: { task: "classify_letter", letterText: safe },
      identifiers: {
        names: [...names.client, ...names.others],
        dob,
        memberIds: client.payors.map((p) => p.memberId),
      },
      audit: { entityType: "PayorLetter", entityId: letter.id, task: "classify_letter" },
    });
    const parsed = AiLetterSchema.safeParse(json);
    if (!parsed.success)
      throw new HttpError(502, "The letter could not be classified. Enter the details manually.");
    const fields = verifyExtraction(safe, parsed.data.quotes);
    const extracted = {
      classification: parsed.data.classification,
      fields,
      requirements: parsed.data.requirements.map((r) => pseudonymize(r, names)),
    };
    await tx.payorLetter.update({
      where: { id: letter.id },
      data: {
        classification: parsed.data.classification,
        extracted: extracted as unknown as Prisma.InputJsonValue,
      },
    });
    return { id: letter.id, ...extracted };
  });
}

export async function confirmLetter(
  ctx: OrgCtx,
  letterId: string,
  edits?: { classification?: (typeof LETTER_CLASSES)[number]; requirements?: string[] },
) {
  requirePermission(ctx.role, "letter:confirm");
  return withOrg(ctx, async (tx) => {
    const l = await tx.payorLetter.findUniqueOrThrow({ where: { id: letterId } });
    await assertClientActive(tx, l.clientId);
    const extracted = {
      ...(l.extracted as Record<string, unknown>),
      ...(edits?.requirements ? { requirements: edits.requirements } : {}),
    };
    await tx.payorLetter.update({
      where: { id: letterId },
      data: {
        status: "confirmed",
        confirmedById: ctx.userId,
        confirmedAt: new Date(),
        classification: edits?.classification ?? l.classification,
        extracted: extracted as Prisma.InputJsonValue,
      },
    });
    await audit(tx, { action: "letter:confirm", entityType: "PayorLetter", entityId: letterId });
  });
}
