// The mock bridge's Mac side (JD-26): connection status, Test connection, Keychain secrets, voices and
// the folder picker, answered from the scenario so the Settings window works in the preview and e2e.
import type { DeskBridge, VoiceInfo } from "@jarvis/shared";
import type { Scenario } from "./types";

type Mac = NonNullable<DeskBridge["mac"]>;

export interface MockMacLog {
  /** Every sample spoken, in order. */
  spoken: { text: string; voice: string; rate: number }[];
  /** How many times Settings → Test ran the status files (JD-45). */
  statusTests: number;
}

const VOICES: VoiceInfo[] = [
  { name: "Daniel", locale: "en_GB", sample: "Hello! My name is Daniel." },
  { name: "Karen", locale: "en_AU", sample: "Hi my name is Karen." },
  { name: "Moira", locale: "en_IE", sample: "Hello! My name is Moira." },
  { name: "Samantha", locale: "en_US", sample: "Hello! My name is Samantha." },
  { name: "Serena", locale: "en_GB", sample: "Hello! My name is Serena." },
];

export function createMockMac(scenario: Scenario, settings: Map<string, unknown>): Mac & MockMacLog {
  const spoken: MockMacLog["spoken"] = [];
  let statusTests = 0;
  const folders = [...(scenario.mac?.folders ?? [])];
  return {
    spoken,
    get statusTests() {
      return statusTests;
    },
    connection: async () => scenario.mac?.connection ?? { state: "unconfigured" },
    async testConnection() {
      if (!settings.get("serverUrl")) return { ok: false, error: "Add the server URL first." };
      if (!settings.get("deviceKey"))
        return { ok: false, error: "Paste a device key from the dashboard first." };
      return scenario.mac?.test ?? { ok: true, deviceName: "Matthew's MacBook Pro" };
    },
    pasteSecret: async (key) => void settings.set(key, true),
    clearSecret: async (key) => void settings.set(key, false),
    voices: async () => structuredClone(scenario.mac?.voices ?? VOICES),
    speak: async (text, voice, rate) => void spoken.push({ text, voice, rate }),
    pickFolder: async () => folders.shift(),
    async testStatusFiles() {
      const dirs = settings.get("statusFiles") as
        { barehandsDir?: string; visualizerDir?: string } | undefined;
      if (!dirs?.barehandsDir && !dirs?.visualizerDir)
        throw new Error("Choose a barehands or visualizer folder first.");
      statusTests++;
      // Main takes ~6 s (four states × 1.5 s); the preview stays quick.
      await new Promise((resolve) => setTimeout(resolve, 600));
    },
  };
}
