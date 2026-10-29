import type { LlmProvider, LlmResponse } from "./provider";

/**
 * Amazon Bedrock provider. A stub until AWS and a BAA are in place; see
 * docs/HIPAA_DEPLOYMENT.md. It will use the Bedrock Mantle client
 * (@anthropic-ai/bedrock-sdk) with the "anthropic."-prefixed model ID.
 */
export class BedrockProvider implements LlmProvider {
  readonly name = "bedrock";
  constructor(readonly model: string) {}
  async complete(): Promise<LlmResponse> {
    throw new Error(
      "BedrockProvider is not configured. It requires an AWS account with a signed BAA (docs/HIPAA_DEPLOYMENT.md).",
    );
  }
}
