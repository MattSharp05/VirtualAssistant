// The menu-bar menu (mockup 8), as plain data so it's tested without Electron: tray.ts hands it to
// Menu.buildFromTemplate. The shape is a subset of Electron's MenuItemConstructorOptions.
import type { DeskConnection, UsageResponse } from "@jarvis/shared";
import type { DeskSettings, Face } from "./settingsSchema";
import { menuLabel } from "./windows/layouts";

export interface TrayItem {
  label?: string;
  type?: "normal" | "separator" | "checkbox" | "radio";
  checked?: boolean;
  enabled?: boolean;
  /** Shown on the right; the tray never registers it (the shortcut itself lives elsewhere). */
  accelerator?: string;
  registerAccelerator?: false;
  /** A status dot, drawn by tray.ts. */
  dot?: DeskConnection["state"];
  click?: () => void;
}

export interface TrayState {
  settings: Pick<DeskSettings, "face" | "wakeWordEnabled" | "cameraHands" | "dnd" | "commandBarShortcut">;
  /** Layout names (JD-37): the built-ins, then Matthew's own; the one the windows are in is ticked. */
  layouts: string[];
  activeLayout?: string;
  connection: DeskConnection;
  usage?: UsageResponse;
  /** The updater (JD-46): a newer version to offer, and its download's progress (0–1). */
  update?: { version?: string; downloading?: number; checking?: boolean; ready?: string };
  /** The wake word (JD-43): a status line when it can't listen, and when it last heard "Jarvis". */
  wake?: { line?: string; lastTrigger?: number };
}

export interface TrayActions {
  talk(): void;
  commandBar(): void;
  layout(name: string): void;
  saveLayout(): void;
  setFace(face: Face): void;
  setWakeWord(on: boolean): void;
  setCameraHands(on: boolean): void;
  setDnd(on: boolean): void;
  /** The last "Jarvis" was a false trigger: logged for tuning (JD-43). */
  notMe(): void;
  openSettings(): void;
  checkForUpdates(): void;
  installUpdate(): void;
  quit(): void;
}

/** "Connected as Matthew's MacBook Pro", "Offline: retrying"… one line next to the dot. */
export function connectionLine(c: DeskConnection): string {
  switch (c.state) {
    case "connected":
      return c.deviceName ? `Connected as ${c.deviceName}` : "Connected";
    case "connecting":
      return "Connecting to JARVIS…";
    case "offline":
      return "Offline: retrying";
    case "unauthorized":
      return "Device key not accepted";
    default:
      return "Not paired: open Settings";
  }
}

/** "Plan: 5-hour 42% · weekly 18%", or undefined when the server can't say. */
export function planLine(usage: UsageResponse | undefined): string | undefined {
  if (!usage?.available) return undefined;
  const parts = [
    usage.fiveHour === undefined ? undefined : `5-hour ${usage.fiveHour}%`,
    usage.weekly === undefined ? undefined : `weekly ${usage.weekly}%`,
  ].filter(Boolean);
  return parts.length ? `Plan: ${parts.join(" · ")}` : undefined;
}

/**
 * "Restart to update" once an update is downloaded (JD-74), else "Update to v1.2.10…" when there's one
 * (or its download's progress), then "Check for updates".
 */
export function updateItems(update: TrayState["update"], act: TrayActions): TrayItem[] {
  const offer: TrayItem[] = update?.ready
    ? [{ label: `Restart to update (v${update.ready})`, click: act.installUpdate }]
    : update?.downloading !== undefined
      ? [{ label: `Downloading update… ${Math.floor(update.downloading * 100)}%`, enabled: false }]
      : update?.version
        ? [{ label: `Update to v${update.version}…`, click: act.installUpdate }]
        : [];
  return [
    ...offer,
    update?.checking
      ? { label: "Checking for updates…", enabled: false }
      : { label: "Check for updates", click: act.checkForUpdates },
  ];
}

const separator: TrayItem = { type: "separator" };
const heading = (label: string): TrayItem => ({ label, enabled: false });

export function trayMenu(state: TrayState, act: TrayActions): TrayItem[] {
  const { settings } = state;
  const plan = planLine(state.usage);
  return [
    // ⌥⌥ (a double-tap) can't be a menu accelerator, so the label carries it.
    { label: "Talk to JARVIS (⌥⌥)", click: act.talk },
    {
      label: "Command bar",
      accelerator: settings.commandBarShortcut,
      registerAccelerator: false,
      click: act.commandBar,
    },
    separator,
    heading("Layout"),
    ...state.layouts.map((name): TrayItem => ({
      label: menuLabel(name),
      type: "checkbox",
      checked: name === state.activeLayout,
      click: () => act.layout(name),
    })),
    { label: "Save current layout…", click: act.saveLayout },
    separator,
    heading("Face"),
    {
      label: "Corner orb",
      type: "radio",
      checked: settings.face === "corner",
      click: () => act.setFace("corner"),
    },
    {
      label: "Ambient (full screen)",
      type: "radio",
      checked: settings.face === "ambient",
      click: () => act.setFace("ambient"),
    },
    separator,
    {
      label: "Wake word “Jarvis”",
      type: "checkbox",
      checked: settings.wakeWordEnabled,
      click: () => act.setWakeWord(!settings.wakeWordEnabled),
    },
    ...(settings.wakeWordEnabled && state.wake?.line ? [heading(state.wake.line)] : []),
    ...(settings.wakeWordEnabled
      ? [{ label: "That wasn't me", enabled: state.wake?.lastTrigger !== undefined, click: act.notMe }]
      : []),
    {
      label: "Camera hands",
      type: "checkbox",
      checked: settings.cameraHands,
      click: () => act.setCameraHands(!settings.cameraHands),
    },
    {
      label: "Do not disturb",
      type: "checkbox",
      checked: settings.dnd,
      click: () => act.setDnd(!settings.dnd),
    },
    separator,
    { label: connectionLine(state.connection), dot: state.connection.state, enabled: false },
    ...(plan ? [{ label: plan, enabled: false }] : []),
    {
      label: "Settings…",
      accelerator: "CommandOrControl+,",
      registerAccelerator: false,
      click: act.openSettings,
    },
    ...updateItems(state.update, act),
    { label: "Quit JARVIS Desk", accelerator: "CommandOrControl+Q", click: act.quit },
  ];
}
