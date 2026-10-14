// Which window.desk the renderer talks to: Electron's preload bridge, or the mock bridge driven by a
// scenario (?scenario=<name> in the web preview; demo-day when a browser has no bridge at all).
import { createContext, useContext, type ReactNode } from "react";
import type { DeskBridge } from "@jarvis/shared";
import { createMockBridge, type MockBridge } from "../mock/bridge";
import { findScenario, scenarios } from "../mock/scenarios";

export interface BridgeChoice {
  bridge: DeskBridge;
  /** The scenario name when the mock is in use. */
  scenario?: string;
}

export function chooseBridge(search: string, native: DeskBridge | undefined): BridgeChoice {
  const wanted = new URLSearchParams(search).get("scenario");
  if (!wanted && native?.subscribe) return { bridge: native };
  const name = wanted ?? "demo-day";
  let scenario = findScenario(name);
  if (!scenario)
    console.warn(`Unknown scenario "${name}". Known: ${scenarios.map((s) => s.name).join(", ")}`);
  scenario ??= findScenario("empty")!;
  const bridge = createMockBridge(scenario);
  // e2e (desk/e2e/helpers.ts) waits on this until the scenario's timeline has played out.
  (globalThis as { __deskMock?: MockBridge }).__deskMock = bridge;
  return { bridge, scenario: scenario.name };
}

const BridgeContext = createContext<BridgeChoice | undefined>(undefined);

export function BridgeProvider({ value, children }: { value: BridgeChoice; children: ReactNode }) {
  return <BridgeContext.Provider value={value}>{children}</BridgeContext.Provider>;
}

/** The bridge plus which scenario (if any) drives it. */
export function useBridgeChoice(): BridgeChoice {
  const choice = useContext(BridgeContext);
  if (!choice) throw new Error("useBridge() outside <BridgeProvider>");
  return choice;
}

export function useBridge(): DeskBridge {
  return useBridgeChoice().bridge;
}
