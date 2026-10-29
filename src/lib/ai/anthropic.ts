import Anthropic from "@anthropic-ai/sdk";
import type { LlmProvider, LlmRequest, LlmResponse } from "./provider";

/** Models that accept server-side refusal fallbacks ("default" routing). */
const FALLBACK_MODELS = new Set([
  "claude-opus-5-5",
  "claude-opus-5",
  "claude-fable-5-1",
  "claude-sonnet-5-5",
]);

/**
 * Direct Anthropic API. Local development with synthetic data only; production
 * PHI goes through BedrockProvider under a BAA (docs/HIPAA_DEPLOYMENT.md).
 */
export class AnthropicProvider implements LlmProvider {
  readonly name = "anthropic";
  private client: Anthropic;
  constructor(
    readonly model: string,
    apiKey?: string,
  ) {
    this.client = new Anthropic(apiKey ? { apiKey } : {});
  }

  async complete(req: LlmRequest): Promise<LlmResponse> {
    const response = await this.client.beta.messages.create({
      model: this.model,
      max_tokens: req.maxTokens ?? 16000,
      system: req.system,
      messages: [{ role: "user", content: req.user }],
      output_config: { effort: "medium" },
      ...(FALLBACK_MODELS.has(this.model)
        ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const }
        : {}),
    });
    if (response.stop_reason === "refusal") throw new Error("The model declined this request");
    if (response.stop_reason === "max_tokens") throw new Error("The model response was cut off");
    const text = response.content
      .filter((b) => b.type === "text")
      .map((b) => (b as { text: string }).text)
      .join("");
    return { text, model: response.model };
  }
}
