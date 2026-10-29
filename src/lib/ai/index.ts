/**
 * The single module through which every AI call passes.
 *
 * Pipeline: minimum-necessary payload (pseudonymized, restricted fields removed)
 * → privacy guard (fails closed if an identifier or restricted field slipped in)
 * → provider call → numeric firewall (retry once, then surface the error)
 * → audit event for every attempt (prompt hash, model, section, user).
 */
import { audit, sha256 } from "../audit";
import { currentCtx, withOrg, type Tx } from "../db";
import { env } from "../env";
import { SourcedContext, validateAiText, type FirewallError } from "../firewall";
import { INTAKE_FIELDS } from "../intake/schema";
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

export class AiPrivacyError extends Error {}
export class AiFirewallError extends Error {
  constructor(public errors: FirewallError[]) {
    super(
      `AI output failed the numeric firewall twice: ${errors.map((e) => `${e.kind} (${e.detail})`).join("; ")}`,
    );
  }
}

export type Identifiers = { names: string[]; dob?: string | null; memberIds: string[] };

const RESTRICTED_IDS = INTAKE_FIELDS.filter((f) => f.sensitivity === "restricted").map((f) => f.id);

function dobVariants(dob: string): string[] {
  const [y, m, d] = dob.split("-");
  if (!y || !m || !d) return [dob];
  return [dob, `${m}/${d}/${y}`, `${Number(m)}/${Number(d)}/${y}`, `${m}-${d}-${y}`];
}

/** Defense in depth: refuse to send anything that still contains an identifier or a restricted field. */
export function assertMinimumNecessary(prompt: string, ids: Identifiers) {
  const lower = prompt.toLowerCase();
  for (const n of ids.names)
    if (
      n &&
      n.length >= 2 &&
      new RegExp(`\\b${n.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(lower)
    )
      throw new AiPrivacyError("Prompt contains a client or guardian name");
  if (ids.dob)
    for (const v of dobVariants(ids.dob))
      if (prompt.includes(v)) throw new AiPrivacyError("Prompt contains a date of birth");
  for (const m of ids.memberIds)
    if (m && prompt.includes(m)) throw new AiPrivacyError("Prompt contains a member ID");
  for (const r of RESTRICTED_IDS)
    if (prompt.includes(`"${r}"`)) throw new AiPrivacyError("Prompt contains a restricted intake field");
}

const FIREWALL_RULES = `Numbers policy (strict): never write any digit or spelled-out number (including words like "twelve", "half", "percent", "first", "second"). Every figure must be a token copied exactly from availableValues, written as {{key}}. Refer to the client only as [Client]. If a fact needs a number that has no token, describe it qualitatively instead.`;

/**
 * AI-call audit rows are committed in their own transaction, so a call is
 * recorded even when the surrounding work (e.g., a firewall rejection) rolls back.
 */
async function auditAiCall(tx: Tx, e: Parameters<typeof audit>[1]) {
  const ctx = currentCtx();
  if (ctx) await withOrg(ctx, (t) => audit(t, e));
  else await audit(tx, e);
}

export type DraftResult = { text: string; model: string; attempts: number; promptHash: string };

export async function draftWithFirewall(
  tx: Tx,
  input: {
    system: string;
    payload: Record<string, unknown>;
    sourced: SourcedContext;
    identifiers: Identifiers;
    audit: { entityType: string; entityId: string; section?: string; task: string };
    provider?: LlmProvider;
  },
): Promise<DraftResult> {
  const provider = input.provider ?? llmProvider();
  const system = `${input.system}\n\n${FIREWALL_RULES}`;
  let user = JSON.stringify(input.payload);
  assertMinimumNecessary(system + user, input.identifiers);
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
        await auditAiCall(tx, {
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
          },
        });
        return { text: v.normalized, model, attempts: attempt, promptHash };
      }
      outcome = "firewall_rejected";
      lastErrors = v.errors;
    } catch (e) {
      outcome = "provider_error";
      await auditAiCall(tx, {
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
        },
      });
      throw e;
    }
    await auditAiCall(tx, {
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
    audit: { entityType: string; entityId: string; task: string };
    provider?: LlmProvider;
  },
): Promise<{ json: unknown; model: string }> {
  const provider = input.provider ?? llmProvider();
  const user = JSON.stringify(input.payload);
  assertMinimumNecessary(input.system + user, input.identifiers);
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
    await auditAiCall(tx, {
      action: "ai:call",
      entityType: input.audit.entityType,
      entityId: input.audit.entityId,
      meta: { promptHash, model: provider.model, provider: provider.name, task: input.audit.task, outcome },
    });
  }
}
