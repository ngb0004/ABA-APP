import { z } from "zod";

const EnvSchema = z.object({
  DATABASE_URL: z.string().min(1),
  LLM_PROVIDER: z.enum(["anthropic", "bedrock", "mock"]).default("mock"),
  LLM_MODEL: z.string().default("claude-opus-5-5"),
  ANTHROPIC_API_KEY: z.string().optional(),
  SESSION_SECRET: z.string().min(8).default("change-me-local-dev-only"),
  /** Absolute session lifetime. HIPAA_DEPLOYMENT.md: 12 hours or less. */
  SESSION_HOURS: z.coerce.number().positive().max(12).default(12),
  /** Signed out after this long without activity (see src/lib/auth/idle.ts for what counts). */
  SESSION_IDLE_MINUTES: z.coerce.number().positive().max(30).default(30),
  /** Consecutive failed sign-in attempts (password or authenticator code) before the account locks. */
  AUTH_MAX_FAILED_ATTEMPTS: z.coerce.number().int().min(1).max(100).default(5),
  AUTH_LOCKOUT_MINUTES: z.coerce
    .number()
    .positive()
    .max(24 * 60)
    .default(15),
  /** Sign-in requests allowed per client IP per window (token bucket). */
  AUTH_RATE_LIMIT_MAX: z.coerce.number().int().min(1).default(20),
  AUTH_RATE_LIMIT_WINDOW_SECONDS: z.coerce.number().int().min(1).default(300),
  /**
   * Reverse proxies in front of the app that append to X-Forwarded-For (Railway edge, an ALB: 1;
   * CloudFront + ALB: 2). Without a proxy, Next.js itself fills the header with the socket address,
   * so 1 is also right locally. 0 ignores the header: every client shares one rate-limit bucket.
   */
  TRUSTED_PROXY_COUNT: z.coerce.number().int().min(0).max(10).default(1),
});

export type Env = z.infer<typeof EnvSchema>;

/** Parsed lazily so tests can set process.env before first use. */
export function env(): Env {
  return EnvSchema.parse(process.env);
}
