import { describe, expect, it } from "vitest";
import { configProblems, databaseTlsProblem } from "@/lib/env";
import { seedRefusal } from "../../seed/synthetic/index";

const STRONG = "a".repeat(16) + "b".repeat(16) + "c";
const TLS_URL =
  "postgresql://aba_app:x@db.internal:5432/aba?sslmode=require&sslaccept=strict&sslcert=/etc/ssl/rds-global-bundle.pem";
const base = {
  DATABASE_URL: "postgresql://aba_app:x@localhost:5432/aba",
  LLM_PROVIDER: "mock" as const,
  LLM_MODEL: "m",
  SESSION_SECRET: "change-me-local-dev-only",
  SESSION_HOURS: 12,
  SESSION_IDLE_MINUTES: 30,
  AUTH_MAX_FAILED_ATTEMPTS: 5,
  AUTH_LOCKOUT_MINUTES: 15,
  AUTH_RATE_LIMIT_MAX: 20,
  AUTH_RATE_LIMIT_WINDOW_SECONDS: 300,
  TRUSTED_PROXY_COUNT: 1,
  DEPLOYMENT: "local" as const,
};

describe("startup configuration checks", () => {
  it("allow the placeholder secret for local development only", () => {
    expect(configProblems(base)).toEqual([]);
    expect(configProblems({ ...base, NODE_ENV: "production" })).toHaveLength(1);
    expect(
      configProblems({ ...base, NODE_ENV: "production", SESSION_SECRET: "short-but-random" }),
    ).toHaveLength(1);
    expect(configProblems({ ...base, NODE_ENV: "production", SESSION_SECRET: STRONG })).toEqual([]);
  });

  it("refuse demo mode, the direct AI API and unverified database TLS in a production deployment", () => {
    const prod = { ...base, DEPLOYMENT: "production" as const, SESSION_SECRET: STRONG };
    expect(configProblems({ ...prod, DATABASE_URL: TLS_URL })).toEqual([]);
    const all = configProblems({ ...prod, DEMO_MODE: "true", LLM_PROVIDER: "anthropic" });
    expect(all.join(" ")).toMatch(/DEMO_MODE/);
    expect(all.join(" ")).toMatch(/Bedrock/);
    expect(all.join(" ")).toMatch(/sslmode=require/);
  });

  it("explain each missing TLS parameter (Prisma silently downgrades sslmode=verify-full)", () => {
    expect(databaseTlsProblem("postgresql://u:p@h/db?sslmode=verify-full")).toMatch(/sslmode=require/);
    expect(databaseTlsProblem("postgresql://u:p@h/db?sslmode=require")).toMatch(/sslaccept=strict/);
    expect(databaseTlsProblem("postgresql://u:p@h/db?sslmode=require&sslaccept=strict")).toMatch(/sslcert/);
    expect(databaseTlsProblem(TLS_URL)).toBeNull();
  });
});

describe("synthetic seed guard", () => {
  it("seeds a local database", () => {
    expect(seedRefusal({ DATABASE_URL: "postgresql://a:b@localhost:5432/aba" })).toBeNull();
    expect(seedRefusal({ DATABASE_URL: "postgresql://a:b@127.0.0.1:5432/aba" })).toBeNull();
  });
  it("refuses a remote database outside the demo unless explicitly allowed", () => {
    const remote = { DATABASE_URL: "postgresql://a:b@prod.abc.rds.amazonaws.com:5432/aba" };
    expect(seedRefusal(remote)).toMatch(/Refusing/);
    expect(seedRefusal({ ...remote, ALLOW_SYNTHETIC_SEED: "1" })).toBeNull();
    expect(seedRefusal({ ...remote, DEMO_MODE: "true" })).toBeNull();
  });
  it("always refuses a production deployment", () => {
    expect(
      seedRefusal({
        DEPLOYMENT: "production",
        DEMO_MODE: "true",
        ALLOW_SYNTHETIC_SEED: "1",
        DATABASE_URL: "postgresql://a:b@localhost/aba",
      }),
    ).toMatch(/production/);
  });
});

describe("bundled sample files", () => {
  it("are refused on a production deployment (only real uploads belong there)", async () => {
    const { sampleFile } = await import("@/lib/demo");
    expect(sampleFile("letters", "denial.txt").length).toBeGreaterThan(0);
    process.env.DEPLOYMENT = "production";
    try {
      expect(() => sampleFile("letters", "denial.txt")).toThrow(expect.objectContaining({ status: 404 }));
    } finally {
      delete process.env.DEPLOYMENT;
    }
  });
});
