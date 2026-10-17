import { describe, expect, it } from "vitest";
import { agents } from "../../mock/data/agents";
import {
  CARD,
  COL_GAP,
  FIT_PADDING,
  MAX_ZOOM,
  MIN_ZOOM,
  ROW_GAP,
  edgePath,
  fit,
  layoutTree,
  pan,
  reveal,
  wheelFactor,
  zoomAt,
  type PlacedNode,
} from "./layout";
import { buildTree } from "./model";

const tree = buildTree(agents, { activity: "all" });
const overlaps = (a: PlacedNode, b: PlacedNode) =>
  a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

describe("layoutTree", () => {
  const layout = layoutTree(tree);
  const at = (id: string) => layout.nodes.find((p) => p.node.id === id)!;

  it("places projects, orchestrators and builders in columns left to right", () => {
    expect(at("project:jarvis").x).toBe(0);
    expect(at("session:session_01JDorch13").x).toBe(CARD.project.w + COL_GAP);
    expect(at("session:session_01JD54").x).toBe(
      CARD.project.w + COL_GAP + Math.max(CARD.orchestrator.w, CARD.builder.w) + COL_GAP,
    );
    // A loose builder hangs right under its project, in the orchestrators' column.
    expect(at("session:session_01JDloose").depth).toBe(1);
  });

  it("never overlaps two cards, and keeps siblings ROW_GAP apart", () => {
    for (const a of layout.nodes)
      for (const b of layout.nodes)
        if (a !== b) expect(overlaps(a, b), `${a.node.id} × ${b.node.id}`).toBe(false);
    const b13 = ["session:session_01JD54", "session:session_01JD55", "session:session_01JD57"].map(at);
    expect(b13[1]!.y - (b13[0]!.y + b13[0]!.h)).toBe(ROW_GAP);
  });

  it("centres a parent on its children", () => {
    const orch = at("session:session_01JDorch13");
    const kids = ["session:session_01JD54", "session:session_01JD57"].map(at);
    const span = (kids[0]!.y + kids[0]!.h / 2 + kids[1]!.y + kids[1]!.h / 2) / 2;
    expect(orch.y + orch.h / 2).toBeCloseTo(span);
  });

  it("puts the second project below everything of the first", () => {
    const jarvisBottom = Math.max(
      ...layout.nodes.filter((p) => p.node.project.id === "project:jarvis").map((p) => p.y + p.h),
    );
    const trip = layout.nodes.filter((p) => p.node.project.id === "project:trip");
    expect(Math.min(...trip.map((p) => p.y))).toBeGreaterThan(jarvisBottom);
  });

  it("draws one edge per visible child, from the parent's right edge to the child's left edge", () => {
    expect(layout.edges).toHaveLength(layout.nodes.length - tree.length);
    const e = layout.edges.find((x) => x.to === "session:session_01JD54")!;
    const p = at("session:session_01JDorch13");
    expect(e.d.startsWith(`M${p.x + p.w} ${p.y + p.h / 2}`)).toBe(true);
  });

  it("collapsing hides the subtree, counts it, and drops its edges", () => {
    const shut = layoutTree(tree, new Set(["project:jarvis"]));
    const jarvis = shut.nodes.find((p) => p.node.id === "project:jarvis")!;
    expect(jarvis.hidden).toBe(2 + 3 + 2 + 1); // two runs, their five builders, one loose session
    expect(shut.nodes.some((p) => p.node.id === "session:session_01JD54")).toBe(false);
    expect(shut.edges.some((e) => e.from === "project:jarvis")).toBe(false);
    expect(shut.bounds.h).toBeLessThan(layout.bounds.h);
  });

  it("bounds cover every card; an empty forest has empty bounds", () => {
    const right = Math.max(...layout.nodes.map((p) => p.x + p.w));
    expect(layout.bounds.x + layout.bounds.w).toBe(right);
    expect(layoutTree([]).bounds).toEqual({ x: 0, y: 0, w: 0, h: 0 });
  });
});

describe("viewport maths", () => {
  it("zoomAt keeps the point under the pointer fixed and clamps the zoom", () => {
    const v = { x: 40, y: 20, k: 1 };
    const p = { x: 300, y: 200 };
    const z = zoomAt(v, p, 1.5);
    const world = { x: (p.x - v.x) / v.k, y: (p.y - v.y) / v.k };
    expect(world.x * z.k + z.x).toBeCloseTo(p.x);
    expect(world.y * z.k + z.y).toBeCloseTo(p.y);
    expect(zoomAt(v, p, 100).k).toBe(MAX_ZOOM);
    expect(zoomAt(v, p, 0.001).k).toBe(MIN_ZOOM);
  });

  it("fit centres the bounds inside the padding and never zooms a small tree past 100%", () => {
    const b = { x: 0, y: 0, w: 2000, h: 1000 };
    const v = fit(b, { w: 1000, h: 800 });
    expect(v.k).toBeCloseTo((1000 - 2 * FIT_PADDING) / 2000);
    expect(v.x).toBeCloseTo(FIT_PADDING);
    expect(v.y + (b.h * v.k) / 2).toBeCloseTo(400);
    expect(fit({ x: 0, y: 0, w: 100, h: 50 }, { w: 1000, h: 800 }).k).toBe(1);
    expect(fit({ x: 0, y: 0, w: 0, h: 0 }, { w: 1000, h: 800 }).k).toBe(1);
  });

  it("pan moves, wheelFactor zooms in on negative deltas", () => {
    expect(pan({ x: 1, y: 2, k: 1 }, 10, -5)).toEqual({ x: 11, y: -3, k: 1 });
    expect(wheelFactor(-100)).toBeGreaterThan(1);
    expect(wheelFactor(100)).toBeLessThan(1);
    expect(wheelFactor(0)).toBe(1);
  });

  it("reveal pans just enough to bring a card on screen, and leaves a visible one alone", () => {
    const v = { x: 0, y: 0, k: 1 };
    const size = { w: 800, h: 600 };
    expect(reveal(v, { x: 100, y: 100, w: 200, h: 100 }, size)).toBe(v);
    const r = reveal(v, { x: 900, y: 100, w: 200, h: 100 }, size);
    expect(900 + 200 + r.x).toBe(800 - 24);
  });

  it("edgePath is an S curve between the two edges", () => {
    expect(edgePath({ x: 0, y: 0, w: 100, h: 40 }, { x: 200, y: 100, w: 50, h: 20 })).toBe(
      "M100 20 C150 20 150 110 200 110",
    );
  });
});
