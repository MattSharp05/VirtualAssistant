// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS } from "./settingsSchema";
import { connectionLine, planLine, trayMenu, type TrayActions, type TrayState } from "./trayMenu";
import { orbGlyph, statusDot } from "./trayIcons";

const actions = (): TrayActions => ({
  talk: vi.fn(),
  commandBar: vi.fn(),
  layout: vi.fn(),
  setFace: vi.fn(),
  setWakeWord: vi.fn(),
  setCameraHands: vi.fn(),
  setDnd: vi.fn(),
  openSettings: vi.fn(),
  quit: vi.fn(),
});

const state = (over: Partial<TrayState> = {}): TrayState => ({
  settings: DEFAULT_SETTINGS,
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
      "Save current layout…",
      "—",
      "Face",
      "Corner orb",
      "Ambient (full screen)",
      "—",
      "Wake word “Jarvis”",
      "Camera hands",
      "Do not disturb",
      "—",
      "Connected as MacBook Pro",
      "Plan: 5-hour 42% · weekly 18%",
      "Settings…",
      "Quit JARVIS Desk",
    ]);
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

  it("shows saved layouts (JD-37) under Layout", () => {
    const act = actions();
    const items = trayMenu(state({ settings: { ...DEFAULT_SETTINGS, layouts: { "Work mode": {} } } }), act);
    items.find((i) => i.label === "Work mode")!.click!();
    expect(act.layout).toHaveBeenCalledWith("Work mode");
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
