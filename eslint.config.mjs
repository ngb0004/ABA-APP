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
];

export default config;
