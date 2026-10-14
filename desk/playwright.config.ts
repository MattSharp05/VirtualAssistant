// Desk e2e (docs/TDD.md → Testing strategy):
//   web-desktop: Chromium 1440×900 against the web build (vite preview) driven by mock scenarios.
//   electron:    the real app on CI's Mac (desk-mac job); skipped everywhere else.
// Visual snapshots only with VISUAL=1 (desk-visual job), 0.2% tolerance, baselines from the
// Playwright Linux image (e2e/__snapshots__/).
import { defineConfig } from "@playwright/test";

const PORT = 4173;

export default defineConfig({
  testDir: "e2e",
  snapshotPathTemplate: "e2e/__snapshots__/{testFilePath}/{arg}{ext}",
  expect: { toHaveScreenshot: { maxDiffPixelRatio: 0.002 } },
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  retries: 0,
  projects: [
    {
      name: "web-desktop",
      testMatch: "web/**/*.spec.ts",
      use: {
        baseURL: `http://127.0.0.1:${PORT}`,
        viewport: { width: 1440, height: 900 },
        browserName: "chromium",
        // Cloud sessions have an older Chromium preinstalled; CI uses the Playwright image's own.
        launchOptions: process.env.PW_CHROMIUM_PATH ? { executablePath: process.env.PW_CHROMIUM_PATH } : {},
      },
    },
    { name: "electron", testMatch: "electron/**/*.spec.ts" },
  ],
  webServer: process.argv.includes("--project=electron")
    ? undefined
    : {
        command: `npm run build:web && npx vite preview --mode web --host 127.0.0.1 --port ${PORT} --strictPort`,
        url: `http://127.0.0.1:${PORT}/dev.html`,
        reuseExistingServer: !process.env.CI,
        timeout: 120_000,
      },
});
