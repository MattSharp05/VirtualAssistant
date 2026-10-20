import { useEffect, useRef, type KeyboardEvent, type MouseEvent, type PointerEvent } from "react";
import { labelOffset, pan, wheelFactor, zoomAt, type Layout, type Viewport } from "./layout";
import { Minimap } from "./Minimap";
import type { BandTone } from "./model";
import { NodeCard } from "./NodeCard";

/** A pointer that moves this far is a drag (pan), not a click. */
const DRAG_PX = 4;
/** Arrow keys pan this far; + and − zoom by this factor. */
const KEY_PAN = 60;
const KEY_ZOOM = 1.2;

interface CanvasProps {
  layout: Layout;
  view: Viewport;
  onView(view: Viewport | ((view: Viewport) => Viewport)): void;
  /** The canvas's size on screen (for Fit and zooming around the centre). */
  onSize(size: { w: number; h: number }): void;
  /** The last size reported (for the minimap's viewport). */
  size: { w: number; h: number };
  /** Each project band's status tint, by project id. */
  tones: ReadonlyMap<string, BandTone>;
  onFit(): void;
  selected?: string;
  flash: ReadonlySet<string>;
  collapsed: ReadonlySet<string>;
  onSelect(id: string): void;
  onToggle(id: string): void;
}

/**
 * The pannable, zoomable surface: full-width project bands (screen space, so they always span the
 * canvas) under SVG edges and HTML cards in one transformed world layer, and the overview minimap.
 * Each band's label column is pinned to the canvas's left edge when the world's is off screen.
 * Drag anywhere pans (a drag that starts on a card doesn't click it); ⌘/ctrl + wheel and trackpad
 * pinches zoom around the pointer; the plain wheel scrolls. Keyboard: arrows pan, + / − zoom, 0 fits.
 */
export function Canvas(props: CanvasProps) {
  const { layout, view, onView, onSize, size, tones, onFit, selected, flash, collapsed, onSelect, onToggle } =
    props;
  const el = useRef<HTMLDivElement>(null);
  // The latest view for the native wheel listener and the drag, without re-binding them.
  const viewRef = useRef(view);
  useEffect(() => {
    viewRef.current = view;
  }, [view]);
  const drag = useRef<{ id: number; x: number; y: number; moved: boolean; base: Viewport }>(undefined);
  const suppressClick = useRef(false);

  useEffect(() => {
    const node = el.current;
    if (!node) return;
    const report = () => onSize({ w: node.clientWidth, h: node.clientHeight });
    report();
    const observer = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(report);
    observer?.observe(node);
    // Non-passive, so the page itself never scrolls or zooms under the canvas.
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      if (e.ctrlKey || e.metaKey) {
        const r = node.getBoundingClientRect();
        const at = { x: e.clientX - r.left, y: e.clientY - r.top };
        onView((v) => zoomAt(v, at, wheelFactor(e.deltaY)));
      } else onView((v) => pan(v, -e.deltaX, -e.deltaY));
    };
    node.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      observer?.disconnect();
      node.removeEventListener("wheel", onWheel);
    };
  }, [onSize, onView]);

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    drag.current = { id: e.pointerId, x: e.clientX, y: e.clientY, moved: false, base: viewRef.current };
  };
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    const dx = e.clientX - d.x;
    const dy = e.clientY - d.y;
    if (!d.moved && Math.hypot(dx, dy) < DRAG_PX) return;
    if (!d.moved) {
      d.moved = true;
      // Captured only once it's a drag, so a plain click still lands on the card under it.
      el.current?.setPointerCapture?.(e.pointerId);
    }
    onView(pan(d.base, dx, dy));
  };
  const onPointerUp = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    drag.current = undefined;
    suppressClick.current = d.moved;
  };
  // A drag that ends over a card shouldn't select it.
  const onClickCapture = (e: MouseEvent) => {
    if (!suppressClick.current) return;
    suppressClick.current = false;
    e.stopPropagation();
    e.preventDefault();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.target !== e.currentTarget) return;
    const centre = { x: (el.current?.clientWidth ?? 0) / 2, y: (el.current?.clientHeight ?? 0) / 2 };
    const keys: Record<string, () => Viewport | void> = {
      ArrowLeft: () => pan(view, KEY_PAN, 0),
      ArrowRight: () => pan(view, -KEY_PAN, 0),
      ArrowUp: () => pan(view, 0, KEY_PAN),
      ArrowDown: () => pan(view, 0, -KEY_PAN),
      "+": () => zoomAt(view, centre, KEY_ZOOM),
      "=": () => zoomAt(view, centre, KEY_ZOOM),
      "-": () => zoomAt(view, centre, 1 / KEY_ZOOM),
      "0": onFit,
    };
    const action = keys[e.key];
    if (!action) return;
    e.preventDefault();
    const next = action();
    if (next) onView(next);
  };

  const { bounds } = layout;
  const offset = labelOffset(view);
  return (
    <div
      ref={el}
      className="agents-canvas"
      role="group"
      aria-label="Agent tree"
      aria-roledescription="pannable, zoomable tree"
      tabIndex={0}
      data-zoom={view.k.toFixed(2)}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onClickCapture={onClickCapture}
      onKeyDown={onKeyDown}
    >
      <div className="agents-bands" aria-hidden="true">
        {layout.bands.map((b) => (
          <div
            key={b.id}
            className="agents-band"
            data-band={b.id}
            style={{ top: b.y * view.k + view.y, height: b.h * view.k }}
          />
        ))}
      </div>
      <div
        className="agents-world"
        style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.k})` }}
      >
        <svg
          className="agents-edges"
          aria-hidden="true"
          width={Math.max(1, bounds.x + bounds.w)}
          height={Math.max(1, bounds.y + bounds.h)}
        >
          {layout.edges.map((e) => (
            <path
              key={`${e.from}>${e.to}`}
              d={e.d}
              data-active={e.to === selected || e.from === selected || undefined}
            />
          ))}
        </svg>
        {layout.nodes.map((p) => (
          <NodeCard
            key={p.node.id}
            placed={p}
            selected={p.node.id === selected}
            flash={flash.has(p.node.id)}
            collapsed={collapsed.has(p.node.id)}
            onSelect={onSelect}
            onToggle={onToggle}
            offset={offset}
          />
        ))}
      </div>
      {layout.bands.length > 0 && (
        <Minimap layout={layout} tones={tones} view={view} size={size} onView={onView} />
      )}
    </div>
  );
}
