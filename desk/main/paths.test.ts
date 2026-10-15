// @vitest-environment node
// macOS disks are case-insensitive: Launcher.tsx and launcher.ts are the same file there, and the
// Mac build breaks even though Linux CI is happy. Catch that here.
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const root = fileURLToPath(new URL("..", import.meta.url));
const skip = new Set(["node_modules", "dist", "dist-electron", "test-results", "playwright-report"]);

function clashes(dir: string): string[] {
  const entries = readdirSync(dir, { withFileTypes: true }).filter((e) => !skip.has(e.name));
  const seen = new Map<string, string>();
  const found: string[] = [];
  for (const e of entries) {
    const key = e.name.toLowerCase();
    if (seen.has(key)) found.push(`${join(dir, seen.get(key)!)} vs ${e.name}`);
    seen.set(key, e.name);
    if (e.isDirectory()) found.push(...clashes(join(dir, e.name)));
  }
  return found;
}

it("no two paths differ only by case", () => {
  expect(clashes(root)).toEqual([]);
});
