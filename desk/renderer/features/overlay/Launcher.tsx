import { useEffect, type CSSProperties } from "react";
import { Icon } from "../../app/icons";
import { launcherItems, ringPositions } from "./ringLayout";

interface LauncherProps {
  /** The orb's current diameter: the ring keeps clear of it. */
  orbSize: number;
  onOpen(target: string): void;
  onClose(): void;
}

/** Six round buttons fanned out around the orb; Esc or a click anywhere else closes the ring. */
export function Launcher({ orbSize, onOpen, onClose }: LauncherProps) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const items = launcherItems();
  const positions = ringPositions(items.length, orbSize / 2 + 140);
  return (
    <>
      {/* A pinch anywhere else closes the ring too (camera hands, JD-47). */}
      <div
        className="launcher-backdrop"
        data-testid="launcher-backdrop"
        data-hand-click=""
        onClick={onClose}
      />
      <nav className="launcher" aria-label="Open a window">
        {items.map((item, i) => (
          <button
            key={item.id}
            type="button"
            className="launcher-button"
            aria-label={item.title}
            title={item.title}
            data-launcher-id={item.id}
            style={{ "--x": `${positions[i].x}px`, "--y": `${positions[i].y}px`, "--i": i } as CSSProperties}
            onClick={() => onOpen(item.target)}
          >
            <Icon name={item.icon} size={20} />
            <span className="launcher-label">{item.title}</span>
          </button>
        ))}
      </nav>
    </>
  );
}
