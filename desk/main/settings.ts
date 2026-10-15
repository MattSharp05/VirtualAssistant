// The Desk's settings (schema: settingsSchema.ts): one JSON file in the app's userData folder, written a
// moment after the last change so dragging a window doesn't hammer the disk. Secrets (the device key,
// the Picovoice key) never go in it: they're encrypted with a Keychain-held key (Electron safeStorage)
// into a separate file, and the renderer can store one but never read it back.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { DeskSecret } from "@jarvis/shared";
import {
  isSecretKey,
  isSettingKey,
  migrate,
  SettingError,
  validateSecret,
  validateSetting,
  type DeskSettings,
  type SettingKey,
} from "./settingsSchema";
import type { Rect } from "./windows/bounds";

export * from "./settingsSchema";

/** Electron's safeStorage in the app; a fake in tests. */
export interface Cipher {
  available(): boolean;
  encrypt(plain: string): Buffer;
  decrypt(data: Buffer): string;
}

export interface SettingsOptions {
  /** settings.json */
  file: string;
  /** Where encrypted secrets live (base64 ciphertext per key). */
  secretsFile: string;
  cipher: Cipher;
  delayMs?: number;
}

type Listener = (key: SettingKey | DeskSecret) => void;

function readJson(file: string): unknown {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return undefined;
  }
}

function writeJson(file: string, value: unknown): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(value, null, 2), { mode: 0o600 });
}

export class Settings {
  private values: DeskSettings;
  private readonly unknown: Record<string, unknown>;
  private secrets: Partial<Record<DeskSecret, string>>;
  private readonly listeners = new Set<Listener>();
  private timer?: ReturnType<typeof setTimeout>;

  constructor(private readonly opts: SettingsOptions) {
    const { settings, unknown, strayed } = migrate(readJson(opts.file));
    this.values = settings;
    this.unknown = unknown;
    const stored = readJson(opts.secretsFile);
    this.secrets = typeof stored === "object" && stored !== null ? (stored as typeof this.secrets) : {};
    // A secret in plain JSON (hand-edited, or an old build) moves to the Keychain and out of the file.
    const moved = Object.keys(strayed).length > 0;
    for (const [key, value] of Object.entries(strayed) as [DeskSecret, string][]) {
      try {
        if (!this.hasSecret(key)) this.setSecret(key, value);
      } catch {
        // not a valid key, or no Keychain: dropped either way
      }
    }
    if (moved) this.flush();
  }

  get<K extends SettingKey>(key: K): DeskSettings[K] {
    return structuredClone(this.values[key]);
  }

  all(): DeskSettings {
    return structuredClone(this.values);
  }

  /** Checks and stores a setting; throws SettingError (with a message for people) when it's wrong. */
  set<K extends SettingKey>(key: K, value: unknown): void {
    const next = validateSetting(key, value);
    if (JSON.stringify(next) === JSON.stringify(this.values[key])) return;
    this.values[key] = next;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), this.opts.delayMs ?? 500);
    this.emit(key);
  }

  /** Where a window was last left (JD-20). */
  bounds(id: string): Rect | undefined {
    return this.values.windowBounds[id];
  }

  setBounds(id: string, rect: Rect): void {
    this.set("windowBounds", { ...this.values.windowBounds, [id]: rect });
  }

  hasSecret(key: DeskSecret): boolean {
    return Boolean(this.secrets[key]);
  }

  /** The decrypted secret, for main's own use (never sent to a renderer, never logged). */
  getSecret(key: DeskSecret): string | undefined {
    const stored = this.secrets[key];
    if (!stored || !this.opts.cipher.available()) return undefined;
    try {
      return this.opts.cipher.decrypt(Buffer.from(stored, "base64"));
    } catch {
      return undefined;
    }
  }

  /** Encrypts and stores a secret (undefined removes it). Written at once, never into settings.json. */
  setSecret(key: DeskSecret, value: string | undefined): void {
    if (value === undefined) {
      delete this.secrets[key];
    } else {
      const clean = validateSecret(key, value);
      if (!this.opts.cipher.available())
        throw new SettingError("The macOS Keychain isn't available, so the key can't be stored safely.");
      this.secrets[key] = this.opts.cipher.encrypt(clean).toString("base64");
    }
    writeJson(this.opts.secretsFile, this.secrets);
    this.emit(key);
  }

  /** What a renderer may see: a setting's value, or for a secret only whether one is stored. */
  forRenderer(key: string): unknown {
    if (isSecretKey(key)) return this.hasSecret(key);
    if (isSettingKey(key)) return this.get(key);
    throw new SettingError(`There's no setting called "${key}".`);
  }

  /** A renderer's change: settings only; secrets go through the clipboard (pasteSecret). */
  setFromRenderer(key: string, value: unknown): void {
    if (isSecretKey(key)) throw new SettingError("Secrets are stored with Paste key, not set directly.");
    if (!isSettingKey(key)) throw new SettingError(`There's no setting called "${key}".`);
    this.set(key, value);
  }

  onChange(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Writes pending changes now (on quit). */
  flush(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
    writeJson(this.opts.file, { ...this.unknown, ...this.values });
  }

  private emit(key: SettingKey | DeskSecret): void {
    for (const fn of this.listeners) fn(key);
  }
}
