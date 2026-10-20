// The tree's geometry (JD-58): a small left-to-right tidy tree in plain TS (no graph library), and
// the pan/zoom maths of the viewport over it. Each project's subtree sits in its own full-width band
// with the project as a label column at the band's left (JD-75), and an overview minimap maps the
// whole world into a small panel. World coordinates are CSS px at zoom 1; the screen
// shows world × k + (x, y).
import type { NodeKind, TreeNode } from "./model";

/** Card sizes by kind (agents.css draws them at exactly these). */
export const CARD: Record<NodeKind, { w: number; h: number }> = {
  // The project is the band's label column: this wide, and as tall as its band (at least this).
  project: { w: 200, h: 96 },
  orchestrator: { w: 264, h: 120 },
  builder: { w: 284, h: 112 },
};
/** Space between columns (where the edges run), between siblings, and between project bands. */
export const COL_GAP = 72;
export const ROW_GAP = 16;
export const PROJECT_GAP = 8;
/** Room inside a band above its first card and below its last. */
export const BAND_PAD = 20;

export interface PlacedNode {
  node: TreeNode;
  depth: number;
  x: number;
  y: number;
  w: number;
  h: number;
  /** Children hidden by collapsing (0 when expanded or a leaf). */
  hidden: number;
}

export interface Edge {
  from: string;
  to: string;
  /** An SVG path from the parent's right edge to the child's left edge. */
  d: string;
}

export interface Bounds {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** One project's horizontal band (world px; it runs the full width of the canvas). */
export interface Band {
  id: string;
  node: TreeNode;
  y: number;
  h: number;
}

export interface Layout {
  nodes: PlacedNode[];
  edges: Edge[];
  bands: Band[];
  bounds: Bounds;
}

/** Where each column starts: the widest card of every column before it, plus the gaps. */
function columnX(depth: number): number {
  const widest = Math.max(CARD.orchestrator.w, CARD.builder.w);
  return depth === 0 ? 0 : CARD.project.w + COL_GAP + (depth - 1) * (widest + COL_GAP);
}

const count = (n: TreeNode): number => n.children.reduce((sum, c) => sum + 1 + count(c), 0);

/**
 * Lays the forest out: leaves stack top to bottom, a parent sits centred on its children, and a
 * subtree moves down as a whole when its parent would overlap the card above it in its column.
 * Collapsed nodes keep their size and hide what's under them. Each project gets a band from its
 * subtree's top to its bottom (plus BAND_PAD), and its card becomes the band's label column, as tall
 * as the band; projects don't draw edges to their children (the band shows what belongs to them).
 */
export function layoutTree(roots: TreeNode[], collapsed: ReadonlySet<string> = new Set()): Layout {
  const nodes: PlacedNode[] = [];
  const edges: Edge[] = [];
  const bands: Band[] = [];
  // The lowest card bottom so far in each column.
  const floor: number[] = [];

  const place = (node: TreeNode, depth: number, top: number): PlacedNode[] => {
    const { w, h } = CARD[node.kind];
    const shut = collapsed.has(node.id);
    const kids = shut ? [] : node.children;
    const placed: PlacedNode[] = [];
    let y: number;
    if (kids.length === 0) {
      y = top;
    } else {
      let cursor = top;
      const first: PlacedNode[] = [];
      for (const child of kids) {
        const sub = place(child, depth + 1, cursor);
        first.push(sub[0]!);
        placed.push(...sub);
        cursor = Math.max(...sub.filter((p) => p.depth === depth + 1).map((p) => p.y + p.h)) + ROW_GAP;
      }
      const centre = (first[0]!.y + first[0]!.h / 2 + first.at(-1)!.y + first.at(-1)!.h / 2) / 2;
      y = centre - h / 2;
    }
    // Clear the card above in this column, moving the whole subtree if need be.
    const min = (floor[depth] ?? -Infinity) + ROW_GAP;
    const shift = y < min ? min - y : 0;
    const self: PlacedNode = {
      node,
      depth,
      x: columnX(depth),
      y: y + shift,
      w,
      h,
      hidden: shut ? count(node) : 0,
    };
    for (const p of placed) p.y += shift;
    // The floors under the moved subtree move with it.
    for (const p of [self, ...placed]) floor[p.depth] = Math.max(floor[p.depth] ?? -Infinity, p.y + p.h);
    return [self, ...placed];
  };

  let top = 0;
  for (const root of roots) {
    const shut = collapsed.has(root.id);
    const inner = top + BAND_PAD;
    // Everything of this project starts inside its band, below every earlier band, in every column.
    for (let d = 0; d < floor.length; d++) floor[d] = inner - ROW_GAP;
    const placed: PlacedNode[] = [];
    let cursor = inner;
    for (const child of shut ? [] : root.children) {
      const sub = place(child, 1, cursor);
      placed.push(...sub);
      cursor = sub[0]!.y + sub[0]!.h + ROW_GAP;
    }
    const bottom = placed.length ? Math.max(...placed.map((p) => p.y + p.h)) + BAND_PAD : top;
    const h = Math.max(CARD.project.h, bottom - top);
    nodes.push(
      { node: root, depth: 0, x: columnX(0), y: top, w: CARD.project.w, h, hidden: shut ? count(root) : 0 },
      ...placed,
    );
    bands.push({ id: root.id, node: root, y: top, h });
    top += h + PROJECT_GAP;
  }

  const byId = new Map(nodes.map((p) => [p.node.id, p]));
  for (const p of nodes) {
    if (p.depth === 0 || collapsed.has(p.node.id)) continue;
    for (const child of p.node.children) {
      const c = byId.get(child.id);
      if (c) edges.push({ from: p.node.id, to: c.node.id, d: edgePath(p, c) });
    }
  }
  return { nodes, edges, bands, bounds: boundsOf(nodes) };
}

/** A band as a rectangle as wide as the tree, for fitting the view to one project. */
export function bandBounds(band: Band, bounds: Bounds): Bounds {
  return { x: bounds.x, y: band.y, w: bounds.w, h: band.h };
}

/**
 * How far right (world px) a band's label column moves so it stays pinned to the canvas's left edge:
 * 0 while the world's left edge is on screen, else as far as the screen's left edge.
 */
export function labelOffset(view: Viewport): number {
  return Math.max(0, -view.x / view.k);
}

/** A smooth S from the middle of the parent's right edge to the middle of the child's left edge. */
export function edgePath(a: Bounds, b: Bounds): string {
  const x1 = a.x + a.w;
  const y1 = a.y + a.h / 2;
  const x2 = b.x;
  const y2 = b.y + b.h / 2;
  const mid = (x1 + x2) / 2;
  return `M${x1} ${y1} C${mid} ${y1} ${mid} ${y2} ${x2} ${y2}`;
}

export function boundsOf(rects: Bounds[]): Bounds {
  if (rects.length === 0) return { x: 0, y: 0, w: 0, h: 0 };
  const x = Math.min(...rects.map((r) => r.x));
  const y = Math.min(...rects.map((r) => r.y));
  const right = Math.max(...rects.map((r) => r.x + r.w));
  const bottom = Math.max(...rects.map((r) => r.y + r.h));
  return { x, y, w: right - x, h: bottom - y };
}

// ── Viewport ──

export interface Viewport {
  /** Screen px of the world's origin. */
  x: number;
  y: number;
  /** Zoom. */
  k: number;
}

export const MIN_ZOOM = 0.3;
export const MAX_ZOOM = 2;
/** Fit never blows a small tree up past this. */
export const FIT_MAX_ZOOM = 1;
export const FIT_PADDING = 32;

export const clampZoom = (k: number) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, k));

/** Zooms by `factor` keeping the screen point `at` over the same world point. */
export function zoomAt(view: Viewport, at: { x: number; y: number }, factor: number): Viewport {
  const k = clampZoom(view.k * factor);
  const f = k / view.k;
  return { k, x: at.x - (at.x - view.x) * f, y: at.y - (at.y - view.y) * f };
}

export function pan(view: Viewport, dx: number, dy: number): Viewport {
  return { ...view, x: view.x + dx, y: view.y + dy };
}

/** The view that shows all of `bounds` inside a `size` screen, centred, with padding. */
export function fit(bounds: Bounds, size: { w: number; h: number }, padding = FIT_PADDING): Viewport {
  if (bounds.w === 0 || bounds.h === 0 || size.w === 0 || size.h === 0)
    return { x: padding, y: padding, k: 1 };
  const k = clampZoom(
    Math.min(FIT_MAX_ZOOM, (size.w - 2 * padding) / bounds.w, (size.h - 2 * padding) / bounds.h),
  );
  return {
    k,
    x: (size.w - bounds.w * k) / 2 - bounds.x * k,
    y: (size.h - bounds.h * k) / 2 - bounds.y * k,
  };
}

/** The wheel's zoom factor: a trackpad pinch (ctrl + small deltas) and ⌘-scroll both land here. */
export function wheelFactor(deltaY: number): number {
  return Math.exp(-deltaY * 0.0025);
}

/** The view that brings `rect` into a `size` screen (unchanged when it's already fully visible). */
export function reveal(view: Viewport, rect: Bounds, size: { w: number; h: number }, margin = 24): Viewport {
  const left = rect.x * view.k + view.x;
  const top = rect.y * view.k + view.y;
  const right = left + rect.w * view.k;
  const bottom = top + rect.h * view.k;
  let dx = 0;
  let dy = 0;
  if (left < margin) dx = margin - left;
  else if (right > size.w - margin) dx = Math.max(margin - left, size.w - margin - right);
  if (top < margin) dy = margin - top;
  else if (bottom > size.h - margin) dy = Math.max(margin - top, size.h - margin - bottom);
  return dx || dy ? pan(view, dx, dy) : view;
}

/** The part of the world a `size` screen shows through `view`. */
export function visibleWorld(view: Viewport, size: { w: number; h: number }): Bounds {
  return { x: -view.x / view.k, y: -view.y / view.k, w: size.w / view.k, h: size.h / view.k };
}

/** The view that puts the world point `at` in the middle of a `size` screen, at the same zoom. */
export function centreOn(
  view: Viewport,
  at: { x: number; y: number },
  size: { w: number; h: number },
): Viewport {
  return { k: view.k, x: size.w / 2 - at.x * view.k, y: size.h / 2 - at.y * view.k };
}

// ── Minimap ──

/** How the world maps into the minimap: map = world × scale + offset (centred in the map). */
export interface MapTransform {
  scale: number;
  x: number;
  y: number;
}

/** Fits `world` into a `map`-sized panel, centred; an empty world maps 1:1 at the corner. */
export function mapTransform(world: Bounds, map: { w: number; h: number }): MapTransform {
  if (world.w <= 0 || world.h <= 0) return { scale: 1, x: 0, y: 0 };
  const scale = Math.min(map.w / world.w, map.h / world.h);
  return {
    scale,
    x: (map.w - world.w * scale) / 2 - world.x * scale,
    y: (map.h - world.h * scale) / 2 - world.y * scale,
  };
}

export function worldToMap(t: MapTransform, r: Bounds): Bounds {
  return { x: r.x * t.scale + t.x, y: r.y * t.scale + t.y, w: r.w * t.scale, h: r.h * t.scale };
}

export function mapToWorld(t: MapTransform, p: { x: number; y: number }): { x: number; y: number } {
  return { x: (p.x - t.x) / t.scale, y: (p.y - t.y) / t.scale };
}
