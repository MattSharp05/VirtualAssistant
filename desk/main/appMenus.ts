// The app's own menus (JD-62), as plain data so they're tested without Electron: the application menu
// (⌘Q, ⌘, and Edit's copy/paste in every window), the Dock icon's right-click menu and the orb's
// right-click menu. index.ts hands them to Menu.buildFromTemplate; macOS adds Quit to the Dock menu.
// The shape is a subset of Electron's MenuItemConstructorOptions.

export interface AppMenuItem {
  label?: string;
  type?: "normal" | "separator" | "checkbox" | "submenu";
  /** One of Electron's built-in roles (about, quit, editMenu…): macOS supplies label, shortcut and action. */
  role?:
    | "about"
    | "hide"
    | "hideOthers"
    | "unhide"
    | "quit"
    | "editMenu"
    | "windowMenu"
    | "cut"
    | "copy"
    | "paste"
    | "selectAll";
  checked?: boolean;
  enabled?: boolean;
  accelerator?: string;
  click?: () => void;
  submenu?: AppMenuItem[];
}

export interface AppMenuActions {
  openSettings(): void;
  commandBar(): void;
  setDnd(on: boolean): void;
  /** Every way out goes here (desk:quit → app.quit()). */
  quit(): void;
  /** DevTools for the focused window, else the overlay (JD-63). */
  devTools(): void;
  /** Restart now on a downloaded update (JD-74). */
  restartToUpdate?(): void;
}

export const APP_NAME = "JARVIS Desk";
const separator: AppMenuItem = { type: "separator" };

/**
 * The menu bar while a JARVIS window is in front: the app menu (About, Settings… ⌘,, Hide, Quit ⌘Q),
 * Edit (so ⌘C/⌘V/⌘A keep working in text fields), View (Developer Tools ⌥⌘I, JD-63) and Window.
 */
export function applicationMenu(act: AppMenuActions): AppMenuItem[] {
  return [
    {
      label: APP_NAME,
      submenu: [
        { role: "about" },
        separator,
        { label: "Settings…", accelerator: "CommandOrControl+,", click: act.openSettings },
        separator,
        { role: "hide" },
        { role: "hideOthers" },
        { role: "unhide" },
        separator,
        { label: `Quit ${APP_NAME}`, accelerator: "CommandOrControl+Q", click: act.quit },
      ],
    },
    { role: "editMenu" },
    {
      label: "View",
      submenu: [{ label: "Developer Tools", accelerator: "Alt+CommandOrControl+I", click: act.devTools }],
    },
    { role: "windowMenu" },
  ];
}

/** The Dock icon's right-click menu; macOS adds Options, Show in Finder and Quit below it. */
export function dockMenu(dnd: boolean, act: AppMenuActions, updateReady?: string): AppMenuItem[] {
  return [
    // A downloaded update (JD-74): the same Restart to update as the tray's.
    ...(updateReady && act.restartToUpdate
      ? [{ label: `Restart to update (v${updateReady})`, click: act.restartToUpdate }, separator]
      : []),
    { label: "Command bar", click: act.commandBar },
    { label: "Open Settings…", click: act.openSettings },
    separator,
    { label: "Do Not Disturb", type: "checkbox", checked: dnd, click: () => act.setDnd(!dnd) },
  ];
}

/** The orb's right-click (or control-click) menu: kept tiny. */
export function orbMenu(act: AppMenuActions): AppMenuItem[] {
  return [
    { label: "Settings…", click: act.openSettings },
    separator,
    { label: `Quit ${APP_NAME}`, click: act.quit },
  ];
}

/** What a click on the Dock icon opens: the command bar, or Settings until the Desk is paired. */
export function dockClickTarget(paired: boolean): "commandbar" | "settings" {
  return paired ? "commandbar" : "settings";
}

/** What a right-click hit, from Electron's context-menu params. */
export interface TextMenuTarget {
  isEditable: boolean;
  selectionText: string;
  linkURL: string;
  editFlags: { canCut: boolean; canCopy: boolean; canPaste: boolean; canSelectAll: boolean };
}

/**
 * The right-click menu in every window (text fields, selected text, links): Cut / Copy / Paste /
 * Select All, plus Copy Link. Empty when there's nothing to offer, so the orb keeps its own menu.
 */
export function textMenu(t: TextMenuTarget, copyLink: (url: string) => void): AppMenuItem[] {
  const items: AppMenuItem[] = [];
  if (t.isEditable) {
    items.push(
      { role: "cut", enabled: t.editFlags.canCut },
      { role: "copy", enabled: t.editFlags.canCopy },
      { role: "paste", enabled: t.editFlags.canPaste },
      separator,
      { role: "selectAll", enabled: t.editFlags.canSelectAll },
    );
  } else if (t.selectionText.trim()) {
    items.push({ role: "copy" });
  }
  if (t.linkURL) {
    if (items.length) items.push(separator);
    items.push({ label: "Copy Link", click: () => copyLink(t.linkURL) });
  }
  return items;
}
