// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  activeLayout,
  allLayouts,
  BUILT_IN,
  captureLayout,
  cleanName,
  findLayout,
  FOCUS,
  placeWindow,
  planLayout,
  readLayout,
  WORK_MODE,
  type Display,
} from "./layouts";

// A 16" MacBook Pro (menu bar 37 pt) and a 13" Air beside it, both with their own ids.
const big: Display = { id: 1, workArea: { x: 0, y: 37, width: 1728, height: 1080 } };
const small: Display = { id: 2, workArea: { x: 1728, y: 25, width: 1280, height: 775 } };
const inside = (r: { x: number; y: number; width: number; height: number }, d: Display) =>
  r.x >= d.workArea.x &&
  r.y >= d.workArea.y &&
  r.x + r.width <= d.workArea.x + d.workArea.width &&
  r.y + r.height <= d.workArea.y + d.workArea.height;

describe("saved layouts (JD-37)", () => {
  it("save → apply round-trips the same bounds on the same displays", () => {
    const open = [
      { windowId: "chat", bounds: { x: 100, y: 80, width: 700, height: 600 } },
      { windowId: "today?section=inbox", bounds: { x: 1800, y: 60, width: 900, height: 700 } },
    ];
    const layout = captureLayout(open, [big, small], (b) => (b.x >= 1728 ? 2 : 1));
    expect(layout.windows.map((w) => w.displayId)).toEqual([1, 2]);
    // Through settings.json and back.
    const stored = readLayout(JSON.parse(JSON.stringify(layout)))!;
    const plan = planLayout(stored, ["chat", "sessions"], [big, small], 1);
    expect(plan.place).toEqual(open);
    expect(plan.close).toEqual(["sessions"]);
  });

  it("on a smaller display, scales the bounds and keeps them on the screen", () => {
    const layout = captureLayout(
      [
        { windowId: "sessions", bounds: { x: 24, y: 61, width: 1000, height: 1000 } },
        { windowId: "chat", bounds: { x: 1100, y: 500, width: 620, height: 600 } },
      ],
      [big],
      () => 1,
    );
    // Only the Air is connected now: the big display's id is gone, so it lands on the primary.
    const plan = planLayout(layout, [], [small], 2);
    for (const p of plan.place) expect(inside(p.bounds, small)).toBe(true);
    const [sessions, chat] = plan.place.map((p) => p.bounds);
    expect(sessions.width).toBe(Math.round((1000 * 1280) / 1728));
    expect(sessions.x).toBe(1728 + Math.round((24 * 1280) / 1728));
    // Arrangement kept: chat still right of sessions, in the lower half.
    expect(chat.x).toBeGreaterThan(sessions.x + sessions.width - 1);
    expect(chat.y).toBeGreaterThan(25 + 775 / 3);
  });

  it("grows a window to its minimum size, then clamps it onto the work area", () => {
    const w = { windowId: "todo", bounds: { x: 1600, y: 900, width: 300, height: 200 }, displayId: 1 };
    const r = placeWindow(w, big.workArea, [big], 1, { width: 560, height: 480 });
    expect(r).toEqual({ x: 1728 - 560, y: 37 + 1080 - 480, width: 560, height: 480 });
    // Bigger than the whole screen: the screen's size.
    const huge = placeWindow(
      { ...w, bounds: { x: -50, y: 0, width: 5000, height: 3000 } },
      undefined,
      [small],
      2,
    );
    expect(huge).toEqual(small.workArea);
  });

  it("Work mode puts Sessions left, Today top-middle, Chat bottom-middle, To-do bottom-left", () => {
    const min = (id: string) =>
      ({
        sessions: { width: 760, height: 480 },
        todo: { width: 560, height: 480 },
        today: { width: 420, height: 360 },
        chat: { width: 420, height: 420 },
      })[id];
    const plan = planLayout(BUILT_IN[WORK_MODE], ["notion"], [big], 1, min);
    expect(plan.close).toEqual(["notion"]);
    const at = Object.fromEntries(plan.place.map((p) => [p.windowId, p.bounds]));
    expect(Object.keys(at)).toEqual(["sessions", "today", "chat", "todo"]);
    for (const r of Object.values(at)) expect(inside(r, big)).toBe(true);
    expect(at.today.x).toBeGreaterThanOrEqual(at.sessions.x + at.sessions.width);
    expect(at.chat.x).toBe(at.today.x);
    expect(at.chat.y).toBeGreaterThan(at.today.y + at.today.height - 1);
    expect(at.todo.x).toBe(at.sessions.x);
    expect(at.todo.y).toBeGreaterThan(at.sessions.y);
    // Scaled to the display: the middle column reaches near its right edge.
    expect(1728 - (at.today.x + at.today.width)).toBeLessThan(40);
  });

  it("Focus closes every window", () => {
    expect(planLayout(BUILT_IN[FOCUS], ["chat", "today"], [big], 1)).toEqual({
      place: [],
      close: ["chat", "today"],
    });
  });

  it("lists built-ins first; a saved Work mode replaces the built-in one, Focus can't be replaced", () => {
    const mine = { windows: [{ windowId: "chat", bounds: { x: 0, y: 0, width: 500, height: 500 } }] };
    const all = allLayouts({ Writing: mine, [WORK_MODE]: mine, [FOCUS]: mine, Junk: 3 });
    expect([...all.keys()]).toEqual([WORK_MODE, FOCUS, "Writing"]);
    expect(all.get(WORK_MODE)!.windows.map((w) => w.windowId)).toEqual(["chat"]);
    expect(all.get(FOCUS)!.windows).toEqual([]);
  });

  it("finds a layout from what Matthew says", () => {
    const names = [WORK_MODE, FOCUS, "Writing setup"];
    expect(findLayout("work mode", names)).toBe(WORK_MODE);
    expect(findLayout("Work", names)).toBe(WORK_MODE);
    expect(findLayout("focus mode", names)).toBe(FOCUS);
    expect(findLayout("writing", names)).toBe("Writing setup");
    expect(findLayout("gaming", names)).toBeUndefined();
    expect(findLayout("mode", names)).toBeUndefined();
  });

  it("cleans a typed name", () => {
    expect(cleanName("  My   desk ")).toBe("My desk");
    expect(cleanName("")).toBeUndefined();
    expect(cleanName("focus")).toBeUndefined();
    expect(cleanName("x".repeat(80))).toHaveLength(60);
  });

  it("ticks the layout the windows are in", () => {
    const layouts = allLayouts({});
    const plan = planLayout(BUILT_IN[WORK_MODE], [], [big], 1);
    expect(activeLayout(layouts, plan.place, [big], 1)).toBe(WORK_MODE);
    const nudged = plan.place.map((p, i) => (i ? p : { ...p, bounds: { ...p.bounds, x: p.bounds.x + 3 } }));
    expect(activeLayout(layouts, nudged, [big], 1)).toBe(WORK_MODE);
    expect(activeLayout(layouts, plan.place.slice(1), [big], 1)).toBeUndefined();
    expect(activeLayout(layouts, [], [big], 1)).toBe(FOCUS);
  });

  it("reads hand-edited layouts without breaking", () => {
    expect(readLayout(null)).toBeUndefined();
    expect(readLayout({ windows: "chat" })).toBeUndefined();
    expect(
      readLayout({
        windows: [
          { windowId: "chat", bounds: { x: 1 } },
          { windowId: "today", bounds: { x: 0, y: 0, width: 9, height: 9 } },
        ],
      }),
    ).toEqual({
      windows: [{ windowId: "today", bounds: { x: 0, y: 0, width: 9, height: 9 }, displayId: 0 }],
      displays: {},
    });
  });
});
