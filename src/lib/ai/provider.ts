export type LlmRequest = { system: string; user: string; maxTokens?: number };
export type LlmResponse = { text: string; model: string };

/** Every model integration implements this. Only src/lib/ai/index.ts may call it. */
export interface LlmProvider {
  readonly name: string;
  readonly model: string;
  complete(req: LlmRequest): Promise<LlmResponse>;
}
