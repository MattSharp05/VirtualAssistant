// The orb (JD-19), shared by the corner overlay (features/overlay) and the ambient face (JD-25).
import type { CSSProperties } from "react";
import type { OrbView } from "./useOrb";
import "./orb.css";

interface OrbProps extends OrbView {
  onEnter?(): void;
  onLeave?(): void;
  onClick?(): void;
  /** Right-click or control-click (JD-62): the overlay asks main for the orb's menu. */
  onContextMenu?(): void;
}

/** The orb (mockups 1–2): idle dot, listening pulses, thinking arc, speaking rings; mood colour. */
export function Orb({
  state,
  mood,
  amplitude,
  expanded,
  onEnter,
  onLeave,
  onClick,
  onContextMenu,
}: OrbProps) {
  const style = { "--amp": Math.max(0, Math.min(1, amplitude)).toFixed(2) } as CSSProperties;
  return (
    <button
      type="button"
      className="orb"
      aria-label={`JARVIS (${state})`}
      data-orb-state={state}
      data-orb-mood={mood}
      data-orb-expanded={expanded}
      style={style}
      onMouseEnter={onEnter}
      onMouseLeave={onLeave}
      // A control-click is the Mac's right-click: it opens the menu, not the ring.
      onClick={(e) => !e.ctrlKey && onClick?.()}
      onContextMenu={
        onContextMenu &&
        ((e) => {
          e.preventDefault();
          onContextMenu();
        })
      }
    >
      <span className="orb-core" />
      <span className="orb-ring orb-ring-1" />
      <span className="orb-ring orb-ring-2" />
      <span className="orb-arc" />
    </button>
  );
}
