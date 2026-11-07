/**
 * The single module through which every AI call passes.
 *
 * Pipeline: minimum-necessary payload (pseudonymized, restricted fields removed)
 * → privacy guard (fails closed if an identifier or restricted field slipped in)
 * → provider call → numeric firewall (retry once, then surface the error)
 * → audit event for every attempt (prompt hash, model, section, user).
 */
import { audit, sha256 } from "../audit";
import { currentCtx, withOrg, type OrgCtx, type Tx } from "../db";
import { env } from "../env";
import { SourcedContext, validateAiText, type FirewallError } from "../firewall";
import { INTAKE_FIELDS } from "../intake/schema";
import { findDate } from "../privacy/dates";
import { containsName } from "../privacy/names";
import { AnthropicProvider } from "./anthropic";
import { BedrockProvider } from "./bedrock";
import { MockProvider } from "./mock";
import type { LlmProvider } from "./provider";

export type { LlmProvider } from "./provider";
export { MockProvider } from "./mock";

let override: LlmProvider | null = null;
/** Tests inject a provider. */
export function setLlmProvider(p: LlmProvider | null) {
  override = p;
}

export function llmProvider(): LlmProvider {
  if (override) return override;
  const e = env();
  if (e.LLM_PROVIDER === "anthropic")
    return new AnthropicProvider(e.LLM_MODEL, e.ANTHROPIC_API_KEY || undefined);
  if (e.LLM_PROVIDER === "bedrock") return new BedrockProvider(e.LLM_MODEL);
  return new MockProvider();
}

/** The privacy guard refused a prompt. `check` names which check failed (never the value). */
export class AiPrivacyError extends Error {
  name = "AiPrivacyError";
  constructor(
    message: string,
    public check: "name" | "dob" | "member_id" | "restricted_field",
  ) {
    super(message);
  }
}
export class AiFirewallError extends Error {
  constructor(public errors: FirewallError[]) {
    super(
      `AI output failed the numeric firewall twice: ${errors.map((e) => `${e.kind} (${e.detail})`).join("; ")}`,
    );
  }
}

export type Identifiers = { names: string[]; dob?: string | null; memberIds: string[] };

const RESTRICTED_IDS = INTAKE_FIELDS.filter((f) => f.sensitivity === "restricted").map((f) => f.id);

/** Defense in depth: refuse to send anything that still contains an identifier or a restricted field. */
export function assertMinimumNecessary(prompt: string, ids: Identifiers) {
  for (const n of ids.names)
    if (containsName(prompt, n))
      throw new AiPrivacyError("Prompt contains a client or guardian name", "name");
  // Any written form of the date of birth ("March 4, 2019", "03/04/19", ...), compared as a date.
  if (ids.dob && findDate(prompt, ids.dob).length)
    throw new AiPrivacyError("Prompt contains a date of birth", "dob");
  for (const m of ids.memberIds)
    if (m && prompt.includes(m)) throw new AiPrivacyError("Prompt contains a member ID", "member_id");
  for (const r of RESTRICTED_IDS)
    if (prompt.includes(`"${r}"`))
      throw new AiPrivacyError("Prompt contains a restricted intake field", "restricted_field");
}

const FIREWALL_RULES = `Numbers policy (strict): never write any digit or spelled-out number (including words like "twelve", "half", "percent", "first", "second", "dozens"), numeric symbols such as "½", or month and weekday names. Every figure must be a token copied exactly from availableValues, written as {{key}}. Refer to the client only as [Client]. If a fact needs a number that has no token, describe it qualitatively instead.`;

/**
 * AI-call audit rows are committed in their own transaction, so a call is
 * recorded even when the surrounding work (e.g., a firewall rejection) rolls back.
 */
async function auditAiCall(tx: Tx | null, orgCtx: OrgCtx | undefined, e: Parameters<typeof audit>[1]) {
  const ctx = currentCtx() ?? orgCtx;
  if (ctx) await withOrg(ctx, (t) => audit(t, e));
  else if (tx) await audit(tx, e);
  else throw new Error("AI calls must be audited inside an org context");
}

/**
 * A PHI-free description of what an AI call carried, so a later leak can be scoped: the payload's
 * keys, the intake field ids included, and the total length of its text. Never the values.
 */
export function payloadManifest(payload: Record<string, unknown>) {
  const fieldIds = new Set<string>();
  let textChars = 0;
  const walk = (v: unknown, key: string | null) => {
    if (typeof v === "string") textChars += v.length;
    else if (Array.isArray(v)) v.forEach((x) => walk(x, null));
    else if (v && typeof v === "object") {
      if (key === "fields") for (const k of Object.keys(v)) fieldIds.add(k);
      for (const [k, x] of Object.entries(v)) walk(x, k);
    }
  };
  walk(payload, null);
  return { keys: Object.keys(payload).sort(), fieldIds: [...fieldIds].sort(), textChars };
}

/** Runs the privacy guard; a refusal is audited (which check, never the value) before it is rethrown. */
async function guardOrAudit(
  tx: Tx | null,
  orgCtx: OrgCtx | undefined,
  prompt: string,
  ids: Identifiers,
  a: { entityType: string; entityId: string; section?: string; task: string; clientId?: string },
) {
  try {
    assertMinimumNecessary(prompt, ids);
  } catch (e) {
    if (e instanceof AiPrivacyError)
      await auditAiCall(tx, orgCtx, {
        action: "ai:privacy_blocked",
        entityType: a.entityType,
        entityId: a.entityId,
        meta: { task: a.task, section: a.section ?? null, check: e.check, clientId: a.clientId ?? null },
      });
    throw e;
  }
}

export type DraftResult = { text: string; model: string; attempts: number; promptHash: string };

/**
 * Pass `tx` when already inside a transaction, or null plus `ctx` to call the model
 * outside one (a slow model call must not hold a database transaction open).
 */
export async function draftWithFirewall(
  tx: Tx | null,
  input: {
    ctx?: OrgCtx;
    system: string;
    payload: Record<string, unknown>;
    sourced: SourcedContext;
    identifiers: Identifiers;
    audit: { entityType: string; entityId: string; section?: string; task: string; clientId?: string };
    provider?: LlmProvider;
  },
): Promise<DraftResult> {
  const provider = input.provider ?? llmProvider();
  const system = `${input.system}\n\n${FIREWALL_RULES}`;
  let user = JSON.stringify(input.payload);
  await guardOrAudit(tx, input.ctx, system + user, input.identifiers, input.audit);
  const scope = { clientId: input.audit.clientId ?? null, manifest: payloadManifest(input.payload) };
  let lastErrors: FirewallError[] = [];
  for (let attempt = 1; attempt <= 2; attempt++) {
    const promptHash = sha256(system + "\n" + user);
    let outcome = "ok";
    let model = provider.model;
    try {
      const res = await provider.complete({ system, user });
      model = res.model;
      const v = validateAiText(res.text, input.sourced);
      if (v.ok) {
        await auditAiCall(tx, input.ctx, {
          action: "ai:call",
          entityType: input.audit.entityType,
          entityId: input.audit.entityId,
          meta: {
            promptHash,
            model,
            provider: provider.name,
            task: input.audit.task,
            section: input.audit.section ?? null,
            attempt,
            outcome,
            ...scope,
          },
        });
        return { text: v.normalized, model, attempts: attempt, promptHash };
      }
      outcome = "firewall_rejected";
      lastErrors = v.errors;
    } catch (e) {
      outcome = "provider_error";
      await auditAiCall(tx, input.ctx, {
        action: "ai:call",
        entityType: input.audit.entityType,
        entityId: input.audit.entityId,
        meta: {
          promptHash,
          model,
          provider: provider.name,
          task: input.audit.task,
          section: input.audit.section ?? null,
          attempt,
          outcome,
          ...scope,
        },
      });
      throw e;
    }
    await auditAiCall(tx, input.ctx, {
      action: "ai:call",
      entityType: input.audit.entityType,
      entityId: input.audit.entityId,
      meta: {
        promptHash,
        model,
        provider: provider.name,
        task: input.audit.task,
        section: input.audit.section ?? null,
        attempt,
        outcome,
        errorKinds: lastErrors.map((e) => e.kind),
        ...scope,
      },
    });
    // Retry once, telling the model what was wrong (kinds and keys only).
    user = JSON.stringify({
      ...input.payload,
      previousAttemptRejected: lastErrors.map((e) =>
        e.kind === "unknown_key" ? `unknown key ${e.detail}` : e.kind,
      ),
    });
  }
  throw new AiFirewallError(lastErrors);
}

/** For tasks whose output is structured data (e.g., letter classification). Same privacy guard and audit. */
export async function completeJson(
  tx: Tx,
  input: {
    system: string;
    payload: Record<string, unknown>;
    identifiers: Identifiers;
    audit: { entityType: string; entityId: string; task: string; clientId?: string };
    provider?: LlmProvider;
  },
): Promise<{ json: unknown; model: string }> {
  const provider = input.provider ?? llmProvider();
  const user = JSON.stringify(input.payload);
  await guardOrAudit(tx, undefined, input.system + user, input.identifiers, input.audit);
  const promptHash = sha256(input.system + "\n" + user);
  let outcome = "ok";
  try {
    const res = await provider.complete({ system: input.system, user });
    const raw = res.text.trim().replace(/^```(?:json)?\s*|\s*```$/g, "");
    try {
      return { json: JSON.parse(raw), model: res.model };
    } catch {
      outcome = "invalid_json";
      throw new Error("The model did not return valid JSON");
    }
  } catch (e) {
    if (outcome === "ok") outcome = "provider_error";
    throw e;
  } finally {
    await auditAiCall(tx, undefined, {
      action: "ai:call",
      entityType: input.audit.entityType,
      entityId: input.audit.entityId,
      meta: {
        promptHash,
        model: provider.model,
        provider: provider.name,
        task: input.audit.task,
        outcome,
        clientId: input.audit.clientId ?? null,
        manifest: payloadManifest(input.payload),
      },
    });
  }
}
