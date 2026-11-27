import { defineConfig } from "@playwright/test";

// Regenerates the README screenshots in docs/screenshots from the real UI with
// fictional sample data. Run with `npm run screenshots` from the repo root.
export default defineConfig({
  testDir: "./test/screenshots",
  fullyParallel: false,
  workers: 1,
  reporter: "list",
  use: {
    baseURL: "http://127.0.0.1:18787",
    colorScheme: "dark",
    deviceScaleFactor: 1,
  },
  webServer: {
    command: "node --import tsx test/e2e-server.ts",
    url: "http://127.0.0.1:18787/api/auth/status",
    reuseExistingServer: false,
  },
});
