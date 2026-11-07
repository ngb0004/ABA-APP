import { FlatCompat } from "@eslint/eslintrc";

const compat = new FlatCompat({ baseDirectory: import.meta.dirname });

const config = [
  {
    ignores: [
      ".next/**",
      ".next-e2e/**",
      "exports/**",
      "node_modules/**",
      "test-results/**",
      "playwright-report/**",
      "next-env.d.ts",
    ],
  },
  ...compat.extends("next/core-web-vitals", "next/typescript"),
  {
    rules: {
      // No PHI in application logs: console output is restricted to warn/error,
      // and those must go through src/lib/log.ts which scrubs identifiers.
      "no-console": "error",
    },
  },
  {
    files: ["scripts/**", "seed/**", "src/lib/log.ts", "e2e/**", "tests/**"],
    rules: { "no-console": "off" },
  },
  {
    // Rule 4: raw SQL is invisible to the automatic audit in src/lib/db.ts. New raw queries in src
    // fail lint; a reviewed one is added to the list below, and a raw read of client data must call
    // noteRawRead() so it is audited.
    files: ["src/**"],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector:
            "MemberExpression[property.name=/^\\$(queryRaw|executeRaw|queryRawUnsafe|executeRawUnsafe)$/]",
          message:
            "Raw SQL bypasses the audit log. Use the Prisma model API, or get the query reviewed and add the file to the raw-SQL allowlist in eslint.config.mjs (and call noteRawRead for client data).",
        },
      ],
    },
  },
  {
    // Reviewed raw SQL: RLS scope (db.ts), org listing for curators and the watcher, row locks that
    // return no data, a health check, and the session aggregate (audited with noteRawRead).
    files: [
      "src/lib/db.ts",
      "src/app/api/health/route.ts",
      "src/lib/auth/curator.ts",
      "src/lib/services/client-status.ts",
      "src/lib/services/records.ts",
      "src/lib/services/rules-watch.ts",
      "src/lib/services/plans.ts",
    ],
    rules: { "no-restricted-syntax": "off" },
  },
  {
    // Installs the scrubbing wrapper around console itself (src/instrumentation.ts).
    files: ["src/lib/server/console-scrub.ts"],
    rules: { "no-console": "off" },
  },
];

export default config;
