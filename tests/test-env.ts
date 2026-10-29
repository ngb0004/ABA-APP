// Tests always run against the separate aba_test database.
export const config = {
  DATABASE_URL: process.env.TEST_DATABASE_URL ?? "postgresql://aba_app:aba_app_dev@localhost:5432/aba_test",
  DIRECT_DATABASE_URL:
    process.env.TEST_DIRECT_DATABASE_URL ?? "postgresql://aba_owner:aba_owner_dev@localhost:5432/aba_test",
  LLM_PROVIDER: "mock",
  LLM_MODEL: "mock-model",
  SESSION_SECRET: "test-secret-not-for-production",
};
