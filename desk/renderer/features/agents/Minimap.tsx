import { useRef, type PointerEvent } from "react";
import {
  centreOn,
  mapToWorld,
  mapTransform,
  visibleWorld,
  worldToMap,
  type Layout,
  type Viewport,
} from "./layout";
import type { BandTone } from "./model";

/** The map's drawing area inside the panel (agents.css: 190 × 128 less padding and the heading). */
export const MAP = { w: 174, h: 92 };

interface MinimapProps {
  layout: Layout;
  tones: ReadonlyMap<string, BandTone>;
  view: Viewport;
  size: { w: number; h: number };
  onView(view: Viewport): void;
}

/**
 * The overview (JD-75): every project band as a bar tinted by its status, and the canvas's viewport
 * outlined. Clicking or dragging in the map centres the view on that point.
 */
export function Minimap({ layout, tones, view, size, onView }: MinimapProps) {
  const area = useRef<HTMLDivElement>(null);
  const dragging = useRef<number | undefined>(undefined);
  const t = mapTransform(layout.bounds, MAP);
  const port = worldToMap(t, visibleWorld(view, size));

  const moveTo = (e: PointerEvent<HTMLDivElement>) => {
    const r = area.current?.getBoundingClientRect();
    if (!r) return;
    onView(centreOn(view, mapToWorld(t, { x: e.clientX - r.left, y: e.clientY - r.top }), size));
  };
  // The canvas pans on drags: none of the map's pointer events reach it.
  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    e.stopPropagation();
    if (e.button !== 0) return;
    dragging.current = e.pointerId;
    e.currentTarget.setPointerCapture?.(e.pointerId);
    moveTo(e);
  };
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    e.stopPropagation();
    if (dragging.current === e.pointerId) moveTo(e);
  };
  const onPointerUp = (e: PointerEvent<HTMLDivElement>) => {
    e.stopPropagation();
    if (dragging.current === e.pointerId) dragging.current = undefined;
  };

  const n = layout.bands.length;
  return (
    <div className="agents-minimap" role="group" aria-label="Overview map">
      <span className="agents-eyebrow">
        Overview · {n} {n === 1 ? "project" : "projects"}
      </span>
      <div
        ref={area}
        className="agents-minimap-area"
        style={{ width: MAP.w, height: MAP.h }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      >
        {layout.bands.map((b) => {
          // Bands run the full width of the canvas, so their bars run the full width of the map.
          const r = worldToMap(t, { x: layout.bounds.x, y: b.y, w: layout.bounds.w, h: b.h });
          return (
            <div
              key={b.id}
              className="agents-minimap-band"
              data-band={b.id}
              data-tone={tones.get(b.id) ?? "quiet"}
              title={b.node.project.name}
              style={{ left: 0, top: r.y, width: "100%", height: Math.max(2, r.h) }}
            />
          );
        })}
        <div
          className="agents-minimap-view"
          data-testid="minimap-viewport"
          style={{ left: port.x, top: port.y, width: port.w, height: port.h }}
        />
      </div>
    </div>
  );
}
