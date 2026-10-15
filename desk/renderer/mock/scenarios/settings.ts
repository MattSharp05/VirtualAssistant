// The Settings window (JD-26): paired and connected, the server unreachable, and a fresh install.
import type { Scenario } from "../types";

const SERVER = "https://jarvis.tail1234.ts.net:8443";

const paired = {
  serverUrl: SERVER,
  deviceKey: true,
  voice: "Daniel",
  speechRate: 185,
  pttKey: "RightAlt-double",
  wakeWordEnabled: true,
  wakeSensitivity: 0.6,
  picovoiceKey: true,
  allowedFolders: ["/Users/matthew/Projects", "/Users/matthew/Documents/Trip"],
  statusFiles: { barehandsDir: "/Users/matthew/Projects/barehands/status" },
  face: "corner",
  checkForUpdates: true,
};

const scenarios: Scenario[] = [
  {
    name: "settings",
    description: "Settings on a paired Mac: connected, voice Daniel, two folders; Test connection succeeds.",
    data: {},
    events: [],
    settings: paired,
    mac: {
      connection: { state: "connected", serverUrl: SERVER, deviceName: "Matthew's MacBook Pro" },
      test: { ok: true, deviceName: "Matthew's MacBook Pro" },
      folders: ["/Users/matthew/Desktop/Receipts"],
    },
  },
  {
    name: "settings-offline",
    description: "Settings while the server can't be reached: Test connection fails with the reason.",
    data: {},
    events: [],
    settings: paired,
    mac: {
      connection: {
        state: "offline",
        serverUrl: SERVER,
        error: "Couldn't reach jarvis.tail1234.ts.net:8443 (ECONNREFUSED).",
      },
      test: { ok: false, error: "Couldn't reach jarvis.tail1234.ts.net:8443 (ECONNREFUSED)." },
    },
  },
  {
    name: "settings-first-run",
    description: "A fresh install: no server, no device key. Settings opens by itself.",
    data: {},
    events: [],
    mac: {
      test: { ok: true, deviceName: "Matthew's MacBook Pro" },
      folders: ["/Users/matthew/Projects"],
    },
  },
];

export default scenarios;
