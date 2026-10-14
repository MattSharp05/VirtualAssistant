// Every scenario in this folder, by name (each file default-exports one). Discovered by glob, so a
// ticket adds a scenario file and never edits this one.
import type { Scenario } from "../types";

const modules = import.meta.glob<Scenario>("./*.ts", { eager: true, import: "default" });

export const scenarios: Scenario[] = Object.entries(modules)
  .filter(([path]) => !path.endsWith("/index.ts") && !path.endsWith(".test.ts"))
  .map(([, s]) => s)
  .sort((a, b) => a.name.localeCompare(b.name));

export function findScenario(name: string): Scenario | undefined {
  return scenarios.find((s) => s.name === name);
}
