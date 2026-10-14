// The real app on CI's Mac: launches on the demo-day scenario, checks the window renders, saves a
// screenshot and writes idle memory/CPU to the job summary. Needs Electron's binary (macOS job only).
import { appendFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { _electron as electron, expect, test } from "@playwright/test";

// Playwright needs the fixtures argument destructured, even when empty.
// eslint-disable-next-line no-empty-pattern
test("JARVIS Desk launches and renders its window", async ({}, testInfo) => {
  test.skip(
    process.platform !== "darwin" && !process.env.ELECTRON_SMOKE,
    "Electron runs on the macOS runner only",
  );
  const app = await electron.launch({
    args: ["."],
    cwd: fileURLToPath(new URL("../..", import.meta.url)),
    env: { ...process.env, JARVIS_DESK_SCENARIO: "demo-day" },
  });
  try {
    const window = await app.firstWindow();
    await expect(window.getByRole("heading", { name: "JARVIS Desk" })).toBeVisible({ timeout: 20_000 });
    await expect(window.getByTestId("scenario")).toContainText("demo-day");
    const shot = testInfo.outputPath("electron-smoke.png");
    await window.screenshot({ path: shot });
    await testInfo.attach("app", { path: shot, contentType: "image/png" });

    await window.waitForTimeout(10_000);
    const metrics = await app.evaluate(({ app }) => app.getAppMetrics());
    const rssMb = metrics.reduce((sum, m) => sum + m.memory.workingSetSize, 0) / 1024;
    const cpu = metrics.reduce((sum, m) => sum + m.cpu.percentCPUUsage, 0);
    const line = `Idle after 10 s: ${rssMb.toFixed(0)} MB RSS across ${metrics.length} processes, ${cpu.toFixed(1)}% CPU`;
    console.log(line);
    if (process.env.GITHUB_STEP_SUMMARY)
      appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### Electron smoke\n${line}\n`);
  } finally {
    await app.close();
  }
});
