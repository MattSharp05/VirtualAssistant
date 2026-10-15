// The launcher ring (JD-20, mockup 2): six windows around the orb. Window tickets only register their
// feature id; until one exists its button opens the `hello` placeholder.
import { findFeature } from "../registry";

export interface LauncherItem {
  id: string;
  title: string;
  icon: string;
  /** The window the button opens: the feature itself, or the placeholder. */
  target: string;
}

const RING = [
  { id: "chat", title: "Chat", icon: "chat" },
  { id: "sessions", title: "Sessions", icon: "sessions" },
  { id: "today", title: "Today", icon: "today" },
  { id: "todo", title: "To-do", icon: "todo" },
  { id: "notion", title: "Notion", icon: "notion" },
  { id: "system", title: "System", icon: "system" },
];

export function launcherItems(find = findFeature): LauncherItem[] {
  return RING.map((item) => {
    const feature = find(item.id);
    return feature
      ? { id: item.id, title: feature.title, icon: feature.icon, target: item.id }
      : { ...item, target: "hello" };
  });
}

/**
 * Where each button sits relative to the orb's centre: evenly along an arc from straight left (180°)
 * to straight down (90°), so the ring stays on screen with the orb in the top-right corner.
 */
export function ringPositions(
  count: number,
  radius: number,
  fromDeg = 180,
  toDeg = 90,
): { x: number; y: number }[] {
  return Array.from({ length: count }, (_, i) => {
    const deg = count === 1 ? fromDeg : fromDeg + ((toDeg - fromDeg) * i) / (count - 1);
    const rad = (deg * Math.PI) / 180;
    return { x: Math.round(radius * Math.cos(rad)), y: Math.round(radius * Math.sin(rad)) };
  });
}
