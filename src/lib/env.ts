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
  /**
   * Where this instance runs. "production" marks a deployment that may hold PHI (AWS, under a BAA):
   * it refuses demo mode, sample-file imports, and a database connection without verified TLS.
   */
  DEPLOYMENT: z.enum(["local", "demo", "production"]).default("local"),
  DEMO_MODE: z.string().optional(),
  NODE_ENV: z.string().optional(),
});

/** Placeholder secrets that ship in the repo (.env.example, scripts) and must never run in production. */
const PLACEHOLDER_SECRET = /change-me|not-for-production/i;

/**
 * Prisma 6 (Rust engine) reads sslmode only as disable | prefer | require; anything else, including
 * verify-full, silently becomes prefer. Certificate checks need sslaccept=strict and an sslcert CA.
 */
export function databaseTlsProblem(url: string): string | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return "DATABASE_URL is not a URL";
  }
  const q = u.searchParams;
  if (q.get("sslmode") !== "require") return "DATABASE_URL must set sslmode=require";
  if (q.get("sslaccept") !== "strict")
    return "DATABASE_URL must set sslaccept=strict (verify the server certificate)";
  if (!q.get("sslcert")) return "DATABASE_URL must set sslcert to the database CA bundle";
  return null;
}

/** Startup checks: the problems that make this configuration unsafe, as plain sentences (no values). */
export function configProblems(e: z.infer<typeof EnvSchema>): string[] {
  const problems: string[] = [];
  if (e.NODE_ENV === "production" || e.DEPLOYMENT === "production") {
    if (e.SESSION_SECRET.length < 32 || PLACEHOLDER_SECRET.test(e.SESSION_SECRET))
      problems.push("SESSION_SECRET must be a random value of at least 32 characters, not the placeholder");
  }
  if (e.DEPLOYMENT === "production") {
    if (e.DEMO_MODE === "true") problems.push("DEMO_MODE cannot be on in a production deployment");
    if (e.LLM_PROVIDER === "anthropic")
      problems.push(
        "A production deployment sends AI calls through Bedrock under the BAA, not the direct API",
      );
    const tls = databaseTlsProblem(e.DATABASE_URL);
    if (tls) problems.push(tls);
  }
  return problems;
}

export type Env = z.infer<typeof EnvSchema>;

/** Parsed lazily so tests can set process.env before first use. */
export function env(): Env {
  const e = EnvSchema.parse(process.env);
  const problems = configProblems(e);
  if (problems.length) throw new Error(`Unsafe configuration: ${problems.join("; ")}.`);
  return e;
}

/** Bundled synthetic sample files can be imported anywhere but a production (PHI) deployment. */
export function sampleFilesAllowed(): boolean {
  return process.env.DEMO_MODE === "true" || (process.env.DEPLOYMENT ?? "local") !== "production";
}
