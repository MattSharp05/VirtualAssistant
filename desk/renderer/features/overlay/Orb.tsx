import type { CSSProperties } from "react";
import type { OrbView } from "./useOrb";

interface OrbProps extends OrbView {
  onEnter(): void;
  onLeave(): void;
  onClick(): void;
}

/** The orb (mockups 1–2): idle dot, listening pulses, thinking arc, speaking rings; mood colour. */
export function Orb({ state, mood, amplitude, expanded, onEnter, onLeave, onClick }: OrbProps) {
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
      onClick={onClick}
    >
      <span className="orb-core" />
      <span className="orb-ring orb-ring-1" />
      <span className="orb-ring orb-ring-2" />
      <span className="orb-arc" />
    </button>
  );
}
