// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import {
  applicationMenu,
  dockClickTarget,
  dockMenu,
  orbMenu,
  type AppMenuActions,
  type AppMenuItem,
} from "./appMenus";

const actions = (): AppMenuActions => ({
  openSettings: vi.fn(),
  commandBar: vi.fn(),
  setDnd: vi.fn(),
  quit: vi.fn(),
  devTools: vi.fn(),
});

const names = (items: AppMenuItem[]) => items.map((i) => i.label ?? i.role ?? "—");
const find = (items: AppMenuItem[], label: string) => items.find((i) => i.label === label)!;

describe("app menus (JD-62)", () => {
  it("the application menu has About, Settings… ⌘,, Hide and Quit ⌘Q, then Edit and Window", () => {
    const act = actions();
    const menu = applicationMenu(act);
    expect(names(menu)).toEqual(["JARVIS Desk", "editMenu", "View", "windowMenu"]);
    const app = menu[0]!.submenu!;
    expect(names(app)).toEqual([
      "about",
      "—",
      "Settings…",
      "—",
      "hide",
      "hideOthers",
      "unhide",
      "—",
      "Quit JARVIS Desk",
    ]);
    expect(find(app, "Settings…").accelerator).toBe("CommandOrControl+,");
    const quit = find(app, "Quit JARVIS Desk");
    expect(quit.accelerator).toBe("CommandOrControl+Q");
    quit.click!();
    find(app, "Settings…").click!();
    expect(act.quit).toHaveBeenCalledOnce();
    expect(act.openSettings).toHaveBeenCalledOnce();
  });

  it("View → Developer Tools is ⌥⌘I (JD-63)", () => {
    const act = actions();
    const tools = find(applicationMenu(act), "View").submenu![0]!;
    expect(tools).toMatchObject({ label: "Developer Tools", accelerator: "Alt+CommandOrControl+I" });
    tools.click!();
    expect(act.devTools).toHaveBeenCalledOnce();
  });

  it("the Dock menu opens the command bar and Settings and toggles Do Not Disturb", () => {
    const act = actions();
    const menu = dockMenu(false, act);
    expect(names(menu)).toEqual(["Command bar", "Open Settings…", "—", "Do Not Disturb"]);
    find(menu, "Command bar").click!();
    find(menu, "Open Settings…").click!();
    const dnd = find(menu, "Do Not Disturb");
    expect(dnd).toMatchObject({ type: "checkbox", checked: false });
    dnd.click!();
    expect(act.commandBar).toHaveBeenCalledOnce();
    expect(act.openSettings).toHaveBeenCalledOnce();
    expect(act.setDnd).toHaveBeenCalledWith(true);
    // macOS adds Quit itself; the menu doesn't repeat it.
    expect(names(menu)).not.toContain("Quit JARVIS Desk");
    const on = find(dockMenu(true, act), "Do Not Disturb");
    expect(on.checked).toBe(true);
    on.click!();
    expect(act.setDnd).toHaveBeenLastCalledWith(false);
  });

  it("the orb's menu is Settings… and Quit JARVIS Desk", () => {
    const act = actions();
    const menu = orbMenu(act);
    expect(names(menu)).toEqual(["Settings…", "—", "Quit JARVIS Desk"]);
    find(menu, "Quit JARVIS Desk").click!();
    find(menu, "Settings…").click!();
    expect(act.quit).toHaveBeenCalledOnce();
    expect(act.openSettings).toHaveBeenCalledOnce();
  });

  it("a Dock click opens the command bar, or Settings until the Desk is paired", () => {
    expect(dockClickTarget(true)).toBe("commandbar");
    expect(dockClickTarget(false)).toBe("settings");
  });
});
