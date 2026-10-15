// Saved window layouts (JD-37, mockup 8). A layout is the windows to have open, each with its bounds
// and the display it was on; applying one opens, moves and closes windows to match. Two are built in:
// Work mode (Sessions, Today, Chat and To-do as in the mockup, scaled to the display) and Focus
// (everything closed, only the orb). "Save current layout…" stores Matthew's own in settings.layouts,
// and one he saves as "Work mode" replaces the built-in arrangement. Plain data and pure functions:
// manager.ts and index.ts do the Electron side.
import type { Rect } from "./bounds";

export interface LayoutWindow {
  /** A feature window id, maybe with options ("today?section=inbox"). */
  windowId: string;
  bounds: Rect;
  displayId: number;
}

export interface Layout {
  windows: LayoutWindow[];
  /** The work area of each display the windows were on when saved, by display id. */
  displays: Record<string, Rect>;
}

export interface Display {
  id: number;
  workArea: Rect;
}

export interface Size {
  width: number;
  height: number;
}

export const WORK_MODE = "Work mode";
export const FOCUS = "Focus";
export const MAX_NAME = 60;

/**
 * Mockup 8 on a 1440×900 screen: its work area below the menu bar, and the four windows in it. The
 * left column is as wide as the Sessions window's minimum (760) so it doesn't run under Today and Chat.
 */
const MOCKUP_AREA: Rect = { x: 0, y: 30, width: 1440, height: 870 };
const PRIMARY = 0; // not a real display id, so it falls back to the primary display

export const BUILT_IN: Record<string, Layout> = {
  [WORK_MODE]: {
    displays: { [PRIMARY]: MOCKUP_AREA },
    windows: [
      { windowId: "sessions", bounds: { x: 24, y: 52, width: 760, height: 560 }, displayId: PRIMARY },
      { windowId: "today", bounds: { x: 800, y: 52, width: 616, height: 400 }, displayId: PRIMARY },
      { windowId: "chat", bounds: { x: 800, y: 468, width: 616, height: 410 }, displayId: PRIMARY },
      { windowId: "todo", bounds: { x: 24, y: 628, width: 760, height: 250 }, displayId: PRIMARY },
    ],
  },
  [FOCUS]: { displays: {}, windows: [] },
};

/** How the tray names a layout (mockup 8 spells out what Focus does). */
export const menuLabel = (name: string) => (name === FOCUS ? "Focus (orb only)" : name);

const isRect = (v: unknown): v is Rect =>
  typeof v === "object" &&
  v !== null &&
  ["x", "y", "width", "height"].every((k) => Number.isFinite((v as Record<string, unknown>)[k])) &&
  (v as Rect).width > 0 &&
  (v as Rect).height > 0;

/** A layout read back from settings.json (hand-edited or old ones included); undefined when unusable. */
export function readLayout(value: unknown): Layout | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const { windows, displays } = value as { windows?: unknown; displays?: unknown };
  if (!Array.isArray(windows)) return undefined;
  const list = windows.flatMap((w: unknown): LayoutWindow[] => {
    const { windowId, bounds, displayId } = (w ?? {}) as Record<string, unknown>;
    return typeof windowId === "string" && windowId && isRect(bounds)
      ? [{ windowId, bounds, displayId: Number.isFinite(displayId) ? (displayId as number) : PRIMARY }]
      : [];
  });
  const areas =
    typeof displays === "object" && displays !== null
      ? Object.fromEntries(Object.entries(displays).filter(([, r]) => isRect(r)))
      : {};
  return { windows: list, displays: areas as Record<string, Rect> };
}

/** Every layout by name: the built-ins first (Matthew's own "Work mode" replaces that one), then his. */
export function allLayouts(saved: Record<string, unknown>): Map<string, Layout> {
  const out = new Map<string, Layout>(Object.entries(BUILT_IN));
  for (const [name, value] of Object.entries(saved)) {
    const layout = readLayout(value);
    if (layout && name !== FOCUS) out.set(name, layout);
  }
  return out;
}

/** The layout a spoken or typed name means: exact, then without "mode"/"layout", then a prefix. */
export function findLayout(name: string, names: string[]): string | undefined {
  const norm = (s: string) =>
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .replace(/\b(mode|layout)\b/g, "")
      .trim();
  const wanted = norm(name);
  return (
    names.find((n) => n.toLowerCase() === name.trim().toLowerCase()) ??
    (wanted ? names.find((n) => norm(n) === wanted) : undefined) ??
    (wanted ? names.find((n) => norm(n).startsWith(wanted)) : undefined)
  );
}

/** A name from the save prompt: trimmed, up to MAX_NAME; Focus is taken (it's "close everything"). */
export function cleanName(input: string): string | undefined {
  const name = input.replace(/\s+/g, " ").trim().slice(0, MAX_NAME).trim();
  if (!name || name.toLowerCase() === FOCUS.toLowerCase()) return undefined;
  return name;
}

/** The open windows as a layout, with the work area of each display they're on. */
export function captureLayout(
  open: { windowId: string; bounds: Rect }[],
  displays: Display[],
  displayOf: (bounds: Rect) => number,
): Layout {
  const windows = open.map(({ windowId, bounds }) => ({ windowId, bounds, displayId: displayOf(bounds) }));
  const used = new Set(windows.map((w) => w.displayId));
  return {
    windows,
    displays: Object.fromEntries(displays.filter((d) => used.has(d.id)).map((d) => [d.id, d.workArea])),
  };
}

/**
 * Where one window goes: its bounds scaled from the display it was saved on to the display it's on
 * now (the same one if still connected, else the primary), grown to the window's minimum size and
 * then fitted onto that display's work area. On the display it was saved on, the bounds are unchanged.
 */
export function placeWindow(
  w: LayoutWindow,
  savedArea: Rect | undefined,
  displays: Display[],
  primaryId: number,
  min: Size = { width: 0, height: 0 },
): Rect {
  const target = (displays.find((d) => d.id === w.displayId) ?? displays.find((d) => d.id === primaryId))!
    .workArea;
  const from = savedArea ?? target;
  const sx = target.width / from.width;
  const sy = target.height / from.height;
  const width = Math.min(target.width, Math.max(min.width, Math.round(w.bounds.width * sx)));
  const height = Math.min(target.height, Math.max(min.height, Math.round(w.bounds.height * sy)));
  const x = Math.round(target.x + (w.bounds.x - from.x) * sx);
  const y = Math.round(target.y + (w.bounds.y - from.y) * sy);
  return {
    x: Math.min(Math.max(x, target.x), target.x + target.width - width),
    y: Math.min(Math.max(y, target.y), target.y + target.height - height),
    width,
    height,
  };
}

export interface LayoutPlan {
  /** Windows to open or move, in the layout's order. */
  place: { windowId: string; bounds: Rect }[];
  /** Open windows the layout doesn't have. */
  close: string[];
}

export function planLayout(
  layout: Layout,
  open: string[],
  displays: Display[],
  primaryId: number,
  minSize: (windowId: string) => Size | undefined = () => undefined,
): LayoutPlan {
  const place = layout.windows.map((w) => ({
    windowId: w.windowId,
    bounds: placeWindow(w, layout.displays[w.displayId], displays, primaryId, minSize(w.windowId)),
  }));
  const keep = new Set(place.map((p) => p.windowId));
  return { place, close: open.filter((id) => !keep.has(id)) };
}

/** Within a few points: macOS may nudge a window a little when it's placed. */
const TOLERANCE = 8;
const near = (a: Rect, b: Rect) =>
  (["x", "y", "width", "height"] as const).every((k) => Math.abs(a[k] - b[k]) <= TOLERANCE);

/** The layout the open windows are in right now (the tray's check), if any. */
export function activeLayout(
  layouts: Map<string, Layout>,
  open: { windowId: string; bounds: Rect }[],
  displays: Display[],
  primaryId: number,
  minSize?: (windowId: string) => Size | undefined,
): string | undefined {
  const now = new Map(open.map((w) => [w.windowId, w.bounds]));
  for (const [name, layout] of layouts) {
    const plan = planLayout(layout, [...now.keys()], displays, primaryId, minSize);
    if (plan.close.length || plan.place.length !== now.size) continue;
    if (plan.place.every((p) => now.has(p.windowId) && near(now.get(p.windowId)!, p.bounds))) return name;
  }
  return undefined;
}
