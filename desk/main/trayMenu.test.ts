// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS } from "./settingsSchema";
import { connectionLine, planLine, trayMenu, type TrayActions, type TrayState } from "./trayMenu";
import { orbGlyph, statusDot } from "./trayIcons";

const actions = (): TrayActions => ({
  talk: vi.fn(),
  commandBar: vi.fn(),
  layout: vi.fn(),
  saveLayout: vi.fn(),
  setFace: vi.fn(),
  setWakeWord: vi.fn(),
  setCameraHands: vi.fn(),
  setDnd: vi.fn(),
  notMe: vi.fn(),
  openSettings: vi.fn(),
  checkForUpdates: vi.fn(),
  installUpdate: vi.fn(),
  quit: vi.fn(),
});

const state = (over: Partial<TrayState> = {}): TrayState => ({
  settings: DEFAULT_SETTINGS,
  layouts: ["Work mode", "Focus"],
  activeLayout: "Work mode",
  connection: { state: "connected", serverUrl: "https://j.ts.net", deviceName: "MacBook Pro" },
  usage: { available: true, fiveHour: 42, weekly: 18, checkedAt: "2026-10-15T09:00:00Z" },
  ...over,
});

describe("tray menu (mockup 8)", () => {
  it("lists the mockup's items in order", () => {
    const labels = trayMenu(state(), actions()).map((i) => i.label ?? "—");
    expect(labels).toEqual([
      "Talk to JARVIS (⌥⌥)",
      "Command bar",
      "—",
      "Layout",
      "Work mode",
      "Focus (orb only)",
      "Save current layout…",
      "—",
      "Face",
      "Corner orb",
      "Ambient (full screen)",
      "—",
      "Wake word “Jarvis”",
      "That wasn't me",
      "Camera hands",
      "Do not disturb",
      "—",
      "Connected as MacBook Pro",
      "Plan: 5-hour 42% · weekly 18%",
      "Settings…",
      "Check for updates",
      "Quit JARVIS Desk",
    ]);
  });

  it("offers a newer version (JD-46), shows its download's progress, and forces a check", () => {
    const act = actions();
    const labels = (update: TrayState["update"]) =>
      trayMenu(state({ update }), act)
        .map((i) => i.label)
        .filter((l) => /update/i.test(l ?? ""));
    expect(labels({ version: "1.2.10" })).toEqual(["Update to v1.2.10…", "Check for updates"]);
    expect(labels({ version: "1.2.10", downloading: 0.425 })).toEqual([
      "Downloading update… 42%",
      "Check for updates",
    ]);
    expect(labels({ checking: true })).toEqual(["Checking for updates…"]);
    const items = trayMenu(state({ update: { version: "1.2.10" } }), act);
    items.find((i) => i.label === "Update to v1.2.10…")!.click!();
    items.find((i) => i.label === "Check for updates")!.click!();
    expect(act.installUpdate).toHaveBeenCalled();
    expect(act.checkForUpdates).toHaveBeenCalled();
  });

  it("offers Restart to update once an update is downloaded (JD-74)", () => {
    const act = actions();
    const update = { version: "1.2.10", ready: "1.2.10" };
    const items = trayMenu(state({ update }), act).filter((i) => /update/i.test(i.label ?? ""));
    expect(items.map((i) => i.label)).toEqual(["Restart to update (v1.2.10)", "Check for updates"]);
    items[0]!.click!();
    expect(act.installUpdate).toHaveBeenCalledOnce();
  });

  it("ticks the current face and toggles, and each click flips its setting", () => {
    const act = actions();
    const items = trayMenu(state(), act);
    const item = (label: string) => items.find((i) => i.label === label)!;
    expect(item("Corner orb").checked).toBe(true);
    expect(item("Ambient (full screen)").checked).toBe(false);
    expect(item("Wake word “Jarvis”").checked).toBe(true);
    expect(item("Camera hands").checked).toBe(false);
    expect(item("Do not disturb").checked).toBe(false);
    item("Ambient (full screen)").click!();
    item("Wake word “Jarvis”").click!();
    item("Camera hands").click!();
    item("Do not disturb").click!();
    item("Settings…").click!();
    item("Quit JARVIS Desk").click!();
    expect(act.setFace).toHaveBeenCalledWith("ambient");
    expect(act.setWakeWord).toHaveBeenCalledWith(false);
    expect(act.setCameraHands).toHaveBeenCalledWith(true);
    expect(act.setDnd).toHaveBeenCalledWith(true);
    expect(act.openSettings).toHaveBeenCalled();
    expect(act.quit).toHaveBeenCalled();
  });

  it("lists layouts (JD-37) with a check on the active one, and saves the current one", () => {
    const act = actions();
    const items = trayMenu(
      state({ layouts: ["Work mode", "Focus", "Writing"], activeLayout: "Writing" }),
      act,
    );
    const item = (label: string) => items.find((i) => i.label === label)!;
    expect(item("Work mode")).toMatchObject({ type: "checkbox", checked: false });
    expect(item("Writing").checked).toBe(true);
    item("Focus (orb only)").click!();
    expect(act.layout).toHaveBeenCalledWith("Focus");
    item("Save current layout…").click!();
    expect(act.saveLayout).toHaveBeenCalled();
  });

  it("the status line has a dot for the connection; the plan line hides when usage is unknown", () => {
    const offline = trayMenu(state({ connection: { state: "offline" }, usage: undefined }), actions());
    const status = offline.find((i) => i.dot)!;
    expect(status).toMatchObject({ label: "Offline: retrying", dot: "offline", enabled: false });
    expect(offline.some((i) => i.label?.startsWith("Plan:"))).toBe(false);
    expect(connectionLine({ state: "unconfigured" })).toBe("Not paired: open Settings");
    expect(connectionLine({ state: "unauthorized" })).toBe("Device key not accepted");
    expect(planLine({ available: true, weekly: 7, checkedAt: "" })).toBe("Plan: weekly 7%");
    expect(planLine({ available: false, checkedAt: "" })).toBeUndefined();
  });
});

describe("tray menu: wake word (JD-43)", () => {
  const labels = (s: TrayState) => trayMenu(s, actions()).map((i) => i.label ?? "—");

  it("shows why the wake word can't listen, under its toggle", () => {
    const items = labels(state({ wake: { line: "Wake word: add Picovoice key in Settings" } }));
    const at = items.indexOf("Wake word “Jarvis”");
    expect(items.slice(at, at + 3)).toEqual([
      "Wake word “Jarvis”",
      "Wake word: add Picovoice key in Settings",
      "That wasn't me",
    ]);
  });

  it("“That wasn't me” is enabled once there was a trigger, and reports it", () => {
    const act = actions();
    const before = trayMenu(state(), act).find((i) => i.label === "That wasn't me")!;
    expect(before.enabled).toBe(false);
    const after = trayMenu(state({ wake: { lastTrigger: 1_000 } }), act).find(
      (i) => i.label === "That wasn't me",
    )!;
    expect(after.enabled).toBe(true);
    after.click!();
    expect(act.notMe).toHaveBeenCalledOnce();
  });

  it("hides both when the wake word is off", () => {
    const off = labels(
      state({
        settings: { ...DEFAULT_SETTINGS, wakeWordEnabled: false },
        wake: { line: "Wake word: add Picovoice key in Settings", lastTrigger: 1 },
      }),
    );
    expect(off).not.toContain("That wasn't me");
    expect(off).not.toContain("Wake word: add Picovoice key in Settings");
  });
});

describe("tray icons", () => {
  it("draws a black template orb (ring + dot) with a clear gap between them", () => {
    const img = orbGlyph(2);
    expect(img).toMatchObject({ width: 36, height: 36 });
    expect(img.data.length).toBe(36 * 36 * 4);
    const alpha = (x: number, y: number) => img.data[(y * 36 + x) * 4 + 3];
    expect(alpha(18, 18)).toBe(255); // the dot
    expect(alpha(18 + 10, 18)).toBe(0); // the gap
    expect(alpha(18 + 13, 18)).toBeGreaterThan(200); // the ring
    expect(alpha(0, 0)).toBe(0);
    expect(img.data[(18 * 36 + 18) * 4]).toBe(0); // black
  });

  it("colours the status dot by state", () => {
    const centre = (state: Parameters<typeof statusDot>[0]) => {
      const d = statusDot(state, 1);
      const i = (6 * 12 + 6) * 4;
      return [d.data[i + 2], d.data[i + 1], d.data[i]]; // RGB from BGRA
    };
    expect(centre("connected")).toEqual([0x5f, 0xd4, 0x9a]);
    expect(centre("offline")).toEqual([0xf2, 0x68, 0x5c]);
    expect(centre("unconfigured")).toEqual([0x9a, 0xa7, 0xb2]);
  });
});
