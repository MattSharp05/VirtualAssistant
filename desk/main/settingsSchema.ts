// Every setting the Desk's MVP needs (JD-26 owns this list; later tickets only read it), with its
// default and its check. Plain data and pure functions: the Settings window shares the defaults and
// the URL check, and loading an old or hand-edited settings.json can't break the app.
import type { DeskSecret } from "@jarvis/shared";
import type { Rect } from "./windows/bounds";

/** Push-to-talk: double-tap right Option (⌥⌥), hold right Option, or a function key (F1–F20). */
export type PttKey = "RightAlt-double" | "RightAlt-hold" | `F${number}`;
export type Face = "corner" | "ambient";

/** Folders whose status files the faces can show (optional; later tickets read them). */
export interface StatusFiles {
  barehandsDir?: string;
  visualizerDir?: string;
}

export interface DeskSettings {
  /** The JARVIS server, e.g. https://jarvis.<tailnet>.ts.net:8443 ("" until set). */
  serverUrl: string;
  /** A macOS voice name (`say -v ?`). */
  voice: string;
  /** Words per minute for `say`. */
  speechRate: number;
  /** Say voice replies out loud (JD-38); typed turns are never spoken. */
  speakReplies: boolean;
  pttKey: PttKey;
  wakeWordEnabled: boolean;
  /** Porcupine sensitivity, 0–1. */
  wakeSensitivity: number;
  /** "" = the system's default microphone. */
  micDevice: string;
  dnd: boolean;
  /** Keep listening for "Jarvis" during Do Not Disturb (JD-43; settings.json only for now). */
  wakeDuringDnd: boolean;
  face: Face;
  cameraHands: boolean;
  /** Folders JARVIS may read from this Mac. */
  allowedFolders: string[];
  statusFiles: StatusFiles;
  /** Saved window layouts by name (JD-37 decides their shape). */
  layouts: Record<string, unknown>;
  checkForUpdates: boolean;
  /** Where each window was last left, by feature id (JD-20). */
  windowBounds: Record<string, Rect>;
  // Voice latency tuning (JD-48; settings.json only for now). The defaults are the measured baseline's.
  /** The model voice turns ask ("" = the chat's model), e.g. claude-haiku-5-5 if Sonnet is too slow to start. */
  voiceModel: string;
  /** Silence after the last word before JARVIS decides Matthew has finished (the endpointer's wait). */
  endpointSilenceMs: number;
  /** whisper-cli's CPU threads (-t) and beam size (-bs; 1 = greedy, quicker). */
  whisperThreads: number;
  whisperBeamSize: number;
}

export type SettingKey = keyof DeskSettings;

export const SPEECH_RATE = { min: 120, max: 300 } as const;
export const ENDPOINT_SILENCE = { min: 300, max: 1500 } as const;

export const DEFAULT_SETTINGS: DeskSettings = {
  serverUrl: "",
  voice: "Daniel",
  speechRate: 185,
  speakReplies: true,
  pttKey: "RightAlt-double",
  wakeWordEnabled: true,
  wakeSensitivity: 0.5,
  micDevice: "",
  dnd: false,
  wakeDuringDnd: false,
  face: "corner",
  cameraHands: false,
  allowedFolders: [],
  statusFiles: {},
  layouts: {},
  checkForUpdates: true,
  windowBounds: {},
  voiceModel: "",
  endpointSilenceMs: 700,
  whisperThreads: 4,
  whisperBeamSize: 5,
};

export const SECRET_KEYS: readonly DeskSecret[] = ["deviceKey", "picovoiceKey"];

export class SettingError extends Error {}

export const isSettingKey = (key: string): key is SettingKey => Object.hasOwn(DEFAULT_SETTINGS, key);
export const isSecretKey = (key: string): key is DeskSecret => (SECRET_KEYS as string[]).includes(key);

/**
 * The server's base URL from whatever was pasted: http(s) only, no credentials, query or fragment;
 * trailing slashes and a pasted `/api/desk` are dropped. "" clears it.
 */
export function normalizeServerUrl(input: unknown): string {
  if (typeof input !== "string") throw new SettingError("The server URL must be text.");
  const text = input.trim();
  if (!text) return "";
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new SettingError("That isn't a URL. It looks like https://jarvis.<tailnet>.ts.net:8443");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:")
    throw new SettingError("The server URL must start with https:// (or http:// on this Mac).");
  if (url.username || url.password)
    throw new SettingError("Leave the user name and password out of the URL.");
  if (url.search || url.hash) throw new SettingError("The server URL can't have ?… or #… in it.");
  const path = url.pathname.replace(/\/+$/, "").replace(/\/api\/desk$/, "");
  return `${url.origin}${path}`;
}

const isRect = (v: unknown): v is Rect =>
  typeof v === "object" &&
  v !== null &&
  ["x", "y", "width", "height"].every((k) => Number.isFinite((v as Record<string, unknown>)[k]));

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

function bool(key: string, v: unknown): boolean {
  if (typeof v !== "boolean") throw new SettingError(`${key} must be on or off.`);
  return v;
}

function text(key: string, v: unknown, max = 200): string {
  if (typeof v !== "string" || v.length > max) throw new SettingError(`${key} must be text.`);
  return v;
}

/** A whole number in min..max (clamped), or a SettingError. */
function int(key: string, v: unknown, min: number, max: number): number {
  if (typeof v !== "number" || !Number.isFinite(v)) throw new SettingError(`${key} must be a number.`);
  return Math.round(Math.min(max, Math.max(min, v)));
}

function folder(key: string, v: unknown): string {
  const path = text(key, v, 1024);
  if (!path.startsWith("/")) throw new SettingError(`${key} must be a full folder path.`);
  return path;
}

const validators: { [K in SettingKey]: (v: unknown) => DeskSettings[K] } = {
  serverUrl: normalizeServerUrl,
  voice: (v) => {
    const name = text("voice", v, 100).trim();
    if (!name) throw new SettingError("Pick a voice.");
    return name;
  },
  speechRate: (v) => {
    if (typeof v !== "number" || !Number.isFinite(v)) throw new SettingError("Speed must be a number.");
    return Math.round(Math.min(SPEECH_RATE.max, Math.max(SPEECH_RATE.min, v)));
  },
  speakReplies: (v) => bool("speakReplies", v),
  pttKey: (v) => {
    if (v === "RightAlt-double" || v === "RightAlt-hold") return v;
    if (typeof v === "string" && /^F([1-9]|1[0-9]|20)$/.test(v)) return v as PttKey;
    throw new SettingError("Push-to-talk is ⌥⌥, hold right Option, or F1–F20.");
  },
  wakeWordEnabled: (v) => bool("wakeWordEnabled", v),
  wakeSensitivity: (v) => {
    if (typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > 1)
      throw new SettingError("Sensitivity is between 0 and 1.");
    return v;
  },
  micDevice: (v) => text("micDevice", v),
  dnd: (v) => bool("dnd", v),
  wakeDuringDnd: (v) => bool("wakeDuringDnd", v),
  face: (v) => {
    if (v !== "corner" && v !== "ambient") throw new SettingError("Face is corner or ambient.");
    return v;
  },
  cameraHands: (v) => bool("cameraHands", v),
  allowedFolders: (v) => {
    if (!Array.isArray(v)) throw new SettingError("Folders must be a list.");
    return [...new Set(v.map((f) => folder("A folder", f)))];
  },
  statusFiles: (v) => {
    if (!isPlainObject(v)) throw new SettingError("Status files must be an object.");
    const out: StatusFiles = {};
    for (const k of ["barehandsDir", "visualizerDir"] as const)
      if (v[k] !== undefined && v[k] !== "") out[k] = folder(k, v[k]);
    return out;
  },
  layouts: (v) => {
    if (!isPlainObject(v)) throw new SettingError("Layouts must be an object.");
    return v;
  },
  checkForUpdates: (v) => bool("checkForUpdates", v),
  windowBounds: (v) => {
    if (!isPlainObject(v)) throw new SettingError("Window bounds must be an object.");
    return Object.fromEntries(Object.entries(v).filter(([, r]) => isRect(r))) as Record<string, Rect>;
  },
  voiceModel: (v) => {
    const model = text("voiceModel", v, 100).trim();
    if (model && !/^[a-z0-9][a-z0-9.-]*$/i.test(model)) throw new SettingError("That isn't a model name.");
    return model;
  },
  endpointSilenceMs: (v) => int("endpointSilenceMs", v, ENDPOINT_SILENCE.min, ENDPOINT_SILENCE.max),
  whisperThreads: (v) => int("whisperThreads", v, 1, 16),
  whisperBeamSize: (v) => int("whisperBeamSize", v, 1, 8),
};

/** The checked (and tidied) value for a setting; throws SettingError with a message for people. */
export function validateSetting<K extends SettingKey>(key: K, value: unknown): DeskSettings[K] {
  if (!isSettingKey(key)) throw new SettingError(`There's no setting called "${String(key)}".`);
  return validators[key](value);
}

/** A pasted secret, trimmed; throws when it can't be one (a device key starts with jd_). */
export function validateSecret(key: DeskSecret, value: unknown): string {
  const v = typeof value === "string" ? value.trim() : "";
  if (key === "deviceKey" && !/^jd_[A-Za-z0-9_-]{20,200}$/.test(v))
    throw new SettingError(
      "The clipboard doesn't hold a device key. Copy it from the dashboard (it starts with jd_).",
    );
  if (key === "picovoiceKey" && !/^[A-Za-z0-9+/=_-]{20,512}$/.test(v))
    throw new SettingError(
      "The clipboard doesn't hold a Picovoice AccessKey. Copy it from console.picovoice.ai.",
    );
  return v;
}

export interface Migrated {
  settings: DeskSettings;
  /** Keys this version doesn't know, kept as they were (a newer Desk may have written them). */
  unknown: Record<string, unknown>;
  /** Secrets found in plain JSON (never written there, but moved to the Keychain if they are). */
  strayed: Partial<Record<DeskSecret, string>>;
}

/**
 * Reads whatever settings.json held: known keys are checked (a bad value falls back to its default),
 * JD-20's `window.<id>.bounds` keys move into windowBounds, and unknown keys are kept.
 */
export function migrate(raw: unknown): Migrated {
  const settings: DeskSettings = structuredClone(DEFAULT_SETTINGS);
  const unknown: Record<string, unknown> = {};
  const strayed: Migrated["strayed"] = {};
  if (!isPlainObject(raw)) return { settings, unknown, strayed };
  const set = settings as unknown as Record<string, unknown>;
  for (const [key, value] of Object.entries(raw)) {
    const legacyBounds = /^window\.([a-z0-9-]+)\.bounds$/.exec(key);
    if (legacyBounds) {
      if (isRect(value) && !(isPlainObject(raw.windowBounds) && legacyBounds[1] in raw.windowBounds))
        settings.windowBounds[legacyBounds[1]] = value;
    } else if (isSecretKey(key)) {
      if (typeof value === "string" && value) strayed[key] = value;
    } else if (isSettingKey(key)) {
      try {
        set[key] = validateSetting(key, value);
      } catch {
        // keep the default
      }
    } else {
      unknown[key] = value;
    }
  }
  return { settings, unknown, strayed };
}
