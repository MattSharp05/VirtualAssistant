import { describe, expect, it } from "vitest";
import type { Feature } from "../registry";
import { launcherItems, ringPositions, ringRadius } from "./ringLayout";

describe("launcher ring", () => {
  it("opens registered windows and falls back to the placeholder for the rest", () => {
    const chat = { id: "chat", title: "Chat with JARVIS", icon: "chat" } as Feature;
    const items = launcherItems((id) => (id === "chat" ? chat : undefined));
    expect(items.map((i) => i.id)).toEqual([
      "chat",
      "sessions",
      "agents",
      "today",
      "calendar",
      "todo",
      "notion",
      "system",
    ]);
    expect(items[0]).toMatchObject({ title: "Chat with JARVIS", target: "chat" });
    expect(items[1]).toMatchObject({ title: "Sessions", target: "hello" });
  });

  it("spreads buttons from straight left to straight down, clear of each other", () => {
    const p = ringPositions(6, 154);
    expect(p[0]).toEqual({ x: -154, y: 0 });
    expect(p[5]).toEqual({ x: 0, y: 154 });
    for (let i = 1; i < p.length; i++)
      expect(Math.hypot(p[i].x - p[i - 1].x, p[i].y - p[i - 1].y)).toBeGreaterThan(44);
  });

  it("widens the ring as buttons are added, so all eight keep clear of each other", () => {
    expect(ringRadius(2, 120)).toBe(200);
    const r = ringRadius(8, 120);
    expect(r).toBeGreaterThan(200);
    const p = ringPositions(8, r);
    for (let i = 1; i < p.length; i++)
      expect(Math.hypot(p[i].x - p[i - 1].x, p[i].y - p[i - 1].y)).toBeGreaterThanOrEqual(60);
  });
});
