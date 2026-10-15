// @vitest-environment node
import { describe, expect, it } from "vitest";
import type { Rect } from "../windows/bounds";
import { Layouts, namePromptScript, type LayoutDeps } from "./layout";

const area: Rect = { x: 0, y: 25, width: 1512, height: 957 };

/** A window manager that just remembers where things are. */
function fakeApp(open: Record<string, Rect> = {}, names: (string | undefined)[] = []) {
  const windows = new Map(Object.entries(open));
  let saved: Record<string, unknown> = {};
  const deps: LayoutDeps = {
    windows: {
      openWindows: () => [...windows].map(([windowId, bounds]) => ({ windowId, bounds })),
      windowIds: () => [...windows.keys()],
      placeWindow: (id, bounds) => void windows.set(id, bounds),
      closeWindow: (id) => void windows.delete(id),
      minSize: () => ({ width: 360, height: 240 }),
    },
    saved: () => saved,
    store: (v) => void (saved = v),
    screen: { displays: () => [{ id: 7, workArea: area }], primaryId: () => 7, displayOf: () => 7 },
    askName: async () => names.shift(),
  };
  return { layouts: new Layouts(deps), windows, saved: () => saved };
}

describe("Layouts in the app (JD-37)", () => {
  it("Work mode opens the four windows and closes the rest; Focus closes them all", () => {
    const app = fakeApp({ notion: { x: 10, y: 40, width: 600, height: 500 } });
    expect(app.layouts.apply("work mode")).toEqual({
      name: "Work mode",
      windows: ["sessions", "today", "chat", "todo"],
    });
    expect([...app.windows.keys()].sort()).toEqual(["chat", "sessions", "today", "todo"]);
    expect(app.layouts.active()).toBe("Work mode");
    app.layouts.apply("Focus");
    expect(app.windows.size).toBe(0);
    expect(app.layouts.active()).toBe("Focus");
  });

  it("saves the current windows under a name and puts them back after they move", async () => {
    const chat = { x: 200, y: 100, width: 700, height: 650 };
    const app = fakeApp({ chat }, ["Writing", undefined]);
    expect(await app.layouts.saveCurrent()).toBe("Writing");
    expect(app.layouts.names()).toEqual(["Work mode", "Focus", "Writing"]);
    expect(app.layouts.list().at(-1)).toEqual({ name: "Writing", windows: ["chat"] });
    app.layouts.apply("Work mode");
    app.layouts.apply("Writing");
    expect(Object.fromEntries(app.windows)).toEqual({ chat });
    expect(app.layouts.active()).toBe("Writing");
    // Cancel saves nothing.
    expect(await app.layouts.saveCurrent()).toBeUndefined();
    expect(Object.keys(app.saved())).toEqual(["Writing"]);
  });

  it("answers the server's layout.apply rpc", () => {
    const app = fakeApp();
    expect(app.layouts.answer({ name: "focus" })).toEqual({
      ok: true,
      result: { name: "Focus", windows: [] },
    });
    expect(app.layouts.answer({ name: "gaming" })).toEqual({
      ok: false,
      error: 'There\'s no layout called "gaming". Layouts: Work mode, Focus.',
    });
    expect(app.layouts.answer(null)).toMatchObject({ ok: false });
  });

  it("quotes the suggested name in the AppleScript prompt", () => {
    const [flag, script] = namePromptScript('My "desk"');
    expect(flag).toBe("-e");
    expect(script).toContain('default answer "My \\"desk\\""');
    expect(script).toContain('cancel button "Cancel"');
  });
});
