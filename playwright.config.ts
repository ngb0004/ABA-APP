import { defineConfig } from "@playwright/test";

// E2E_PORT / E2E_DB let a second checkout run the suite alongside the first.
const PORT = Number(process.env.E2E_PORT ?? 3100);
export default defineConfig({
  testDir: "e2e",
  timeout: 90_000,
  workers: 1,
  use: { baseURL: `http://localhost:${PORT}`, trace: "retain-on-failure" },
  webServer: {
    command: `bash scripts/e2e-server.sh ${PORT}`,
    url: `http://localhost:${PORT}/login`,
    timeout: 240_000,
    reuseExistingServer: false,
  },
});
