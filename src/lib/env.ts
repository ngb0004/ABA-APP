import { z } from "zod";

const EnvSchema = z.object({
  DATABASE_URL: z.string().min(1),
  LLM_PROVIDER: z.enum(["anthropic", "bedrock", "mock"]).default("mock"),
  LLM_MODEL: z.string().default("claude-opus-5-5"),
  ANTHROPIC_API_KEY: z.string().optional(),
  SESSION_SECRET: z.string().min(8).default("change-me-local-dev-only"),
});

export type Env = z.infer<typeof EnvSchema>;

/** Parsed lazily so tests can set process.env before first use. */
export function env(): Env {
  return EnvSchema.parse(process.env);
}
