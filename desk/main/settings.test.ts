// @vitest-environment node
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS, migrate, normalizeServerUrl, Settings, type Cipher } from "./settings";

const KEY = "jd_Zm9vYmFyYmF6cXV4cXV1eHF1dXhxdXV4cXV1eA";
const PICO = "aGVsbG8tcGljb3ZvaWNlLWFjY2Vzcy1rZXk=";

/** Reversible but not plain text, like safeStorage. */
const fakeCipher = (available = true): Cipher => ({
  available: () => available,
  encrypt: (s) => Buffer.from(`enc:${[...s].reverse().join("")}`),
  decrypt: (b) => [...b.toString().slice(4)].reverse().join(""),
});

function setup(initial?: unknown, cipher = fakeCipher()) {
  const dir = mkdtempSync(join(tmpdir(), "desk-settings-"));
  const file = join(dir, "settings.json");
  const secretsFile = join(dir, "secrets.json");
  if (initial !== undefined) writeFileSync(file, JSON.stringify(initial));
  const make = () => new Settings({ file, secretsFile, cipher, delayMs: 10 });
  const read = (f: string) => readFileSync(f, "utf8");
  return { dir, file, secretsFile, settings: make(), make, read };
}

describe("settings schema", () => {
  it("starts from the defaults the ticket lists", () => {
    const { settings } = setup();
    expect(settings.all()).toEqual(DEFAULT_SETTINGS);
    expect(settings.get("voice")).toBe("Daniel");
    expect(settings.get("pttKey")).toBe("RightAlt-double");
    expect(settings.get("wakeWordEnabled")).toBe(true);
    expect(settings.get("wakeSensitivity")).toBe(0.5);
    expect(settings.get("face")).toBe("corner");
    expect(settings.get("cameraHands")).toBe(false);
    expect(settings.get("allowedFolders")).toEqual([]);
    expect(settings.get("checkForUpdates")).toBe(true);
  });

  it("normalises a pasted server URL and rejects what isn't one", () => {
    expect(normalizeServerUrl(" https://jarvis.tail1234.ts.net:8443/ ")).toBe(
      "https://jarvis.tail1234.ts.net:8443",
    );
    expect(normalizeServerUrl("https://jarvis.tail1234.ts.net:8443/api/desk/")).toBe(
      "https://jarvis.tail1234.ts.net:8443",
    );
    expect(normalizeServerUrl("http://localhost:3000")).toBe("http://localhost:3000");
    expect(normalizeServerUrl("")).toBe("");
    expect(() => normalizeServerUrl("jarvis.ts.net")).toThrow(/isn't a URL/);
    expect(() => normalizeServerUrl("ftp://jarvis.ts.net")).toThrow(/https/);
    expect(() => normalizeServerUrl("https://me:pw@jarvis.ts.net")).toThrow(/user name/);
    expect(() => normalizeServerUrl("https://jarvis.ts.net/?key=1")).toThrow(/\?/);
  });

  it("checks every value it's given and keeps the old one when a value is wrong", () => {
    const { settings } = setup();
    expect(() => settings.set("serverUrl", "not a url")).toThrow();
    expect(() => settings.set("wakeSensitivity", 1.5)).toThrow(/between 0 and 1/);
    expect(() => settings.set("pttKey", "Space")).toThrow();
    expect(() => settings.set("face", "huge")).toThrow();
    expect(() => settings.set("allowedFolders", ["relative/path"])).toThrow(/full folder path/);
    expect(settings.all()).toEqual(DEFAULT_SETTINGS);
    settings.set("pttKey", "F13");
    settings.set("speechRate", 999);
    settings.set("allowedFolders", ["/Users/matthew/Projects", "/Users/matthew/Projects"]);
    expect(settings.get("pttKey")).toBe("F13");
    expect(settings.get("speechRate")).toBe(300);
    expect(settings.get("allowedFolders")).toEqual(["/Users/matthew/Projects"]);
  });

  it("loads an old or hand-edited file safely: bad values fall back, JD-20 bounds move, unknown keys stay", () => {
    const { settings, file, read } = setup({
      voice: 42,
      wakeSensitivity: 0.8,
      "window.hello.bounds": { x: 1, y: 2, width: 300, height: 200 },
      "window.chat.bounds": { x: "nope" },
      fromTheFuture: { keep: true },
    });
    expect(settings.get("voice")).toBe("Daniel");
    expect(settings.get("wakeSensitivity")).toBe(0.8);
    expect(settings.bounds("hello")).toEqual({ x: 1, y: 2, width: 300, height: 200 });
    expect(settings.bounds("chat")).toBeUndefined();
    settings.flush();
    const saved = JSON.parse(read(file));
    expect(saved.fromTheFuture).toEqual({ keep: true });
    expect(saved["window.hello.bounds"]).toBeUndefined();
    expect(saved.windowBounds.hello).toEqual({ x: 1, y: 2, width: 300, height: 200 });
    expect(migrate("garbage").settings).toEqual(DEFAULT_SETTINGS);
  });

  it("writes a moment after the last change, and survives a restart", async () => {
    const { settings, make, file } = setup();
    settings.set("serverUrl", "https://jarvis.example.ts.net:8443/");
    settings.setBounds("hello", { x: 10, y: 20, width: 400, height: 300 });
    await vi.waitFor(() => expect(readFileSync(file, "utf8")).toContain("jarvis.example"));
    const again = make();
    expect(again.get("serverUrl")).toBe("https://jarvis.example.ts.net:8443");
    expect(again.bounds("hello")).toEqual({ x: 10, y: 20, width: 400, height: 300 });
  });

  it("tells listeners which key changed, and not when nothing did", () => {
    const { settings } = setup();
    const seen: string[] = [];
    settings.onChange((k) => seen.push(k));
    settings.set("dnd", true);
    settings.set("dnd", true);
    settings.setSecret("deviceKey", KEY);
    expect(seen).toEqual(["dnd", "deviceKey"]);
  });
});

describe("secrets", () => {
  it("never appear in settings.json, and aren't plain text in the secrets file", () => {
    const { settings, make, file, secretsFile, read } = setup();
    settings.set("serverUrl", "https://jarvis.example.ts.net:8443");
    settings.setSecret("deviceKey", `  ${KEY}\n`);
    settings.setSecret("picovoiceKey", PICO);
    settings.flush();
    for (const f of [file, secretsFile]) {
      expect(read(f)).not.toContain(KEY);
      expect(read(f)).not.toContain(PICO);
    }
    expect(read(file)).not.toMatch(/deviceKey|picovoiceKey/);
    const again = make();
    expect(again.getSecret("deviceKey")).toBe(KEY);
    expect(again.getSecret("picovoiceKey")).toBe(PICO);
  });

  it("a renderer can only learn whether one is stored, and can't set one directly", () => {
    const { settings } = setup();
    expect(settings.forRenderer("deviceKey")).toBe(false);
    settings.setSecret("deviceKey", KEY);
    expect(settings.forRenderer("deviceKey")).toBe(true);
    expect(settings.forRenderer("voice")).toBe("Daniel");
    expect(() => settings.setFromRenderer("deviceKey", KEY)).toThrow(/Paste key/);
    expect(() => settings.forRenderer("nope")).toThrow();
    settings.setSecret("deviceKey", undefined);
    expect(settings.forRenderer("deviceKey")).toBe(false);
  });

  it("rejects what isn't a key (the clipboard held something else)", () => {
    const { settings } = setup();
    expect(() => settings.setSecret("deviceKey", "hello world")).toThrow(/starts with jd_/);
    expect(() => settings.setSecret("picovoiceKey", "short")).toThrow(/Picovoice/);
    expect(settings.hasSecret("deviceKey")).toBe(false);
  });

  it("refuses to store one when the Keychain isn't available", () => {
    const { settings, secretsFile } = setup(undefined, fakeCipher(false));
    expect(() => settings.setSecret("deviceKey", KEY)).toThrow(/Keychain/);
    expect(() => readFileSync(secretsFile)).toThrow();
  });

  it("moves a secret found in plain settings.json into the Keychain file", () => {
    const { settings, file, read } = setup({ deviceKey: KEY, voice: "Karen" });
    expect(settings.getSecret("deviceKey")).toBe(KEY);
    expect(read(file)).not.toContain(KEY);
    expect(settings.get("voice")).toBe("Karen");
  });
});
