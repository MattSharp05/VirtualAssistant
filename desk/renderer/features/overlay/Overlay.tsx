import { useCallback, useEffect, useMemo, useState, type CSSProperties } from "react";
import { useBridgeChoice } from "../../app/bridge";
import { ErrorBoundary } from "../../app/ErrorBoundary";
import { HandsLayer } from "../hands/HandsLayer";
import { CardsLayer, Hit } from "./cards/CardsLayer";
import { DropCard, DropRing, useFileDrop } from "./DropZone";
import { HitRegions } from "./hitRegions";
import { Launcher } from "./Launcher";
import { Orb } from "./Orb";
import { useOrb } from "./useOrb";
import "./overlay.css";

/**
 * The see-through layer over every app, with the orb in the top-right corner, its launcher ring, the
 * cards beside it (JD-27), file drop on the orb (JD-40) and the hand pointers while Camera hands is on
 * (JD-42). Each layer has its own error boundary (JD-63): one that crashes is logged and dropped, and
 * the orb always stays.
 */
export function Overlay() {
  const { bridge, scenario, ui } = useBridgeChoice();
  const orb = useOrb(bridge);
  const hits = useMemo(() => new HitRegions((on) => bridge.overlay?.setInteractive(on)), [bridge]);
  const [ring, setRing] = useState(ui?.launcherOpen ?? false);
  const drop = useFileDrop(bridge, hits);

  // The window itself must be see-through.
  useEffect(() => {
    document.documentElement.classList.add("overlay-window");
    return () => document.documentElement.classList.remove("overlay-window");
  }, []);

  // While the ring is open the whole overlay takes clicks, so a click anywhere else can close it.
  useEffect(() => {
    if (!ring) return;
    hits.enter("launcher");
    return () => hits.leave("launcher");
  }, [ring, hits]);

  const close = useCallback(() => setRing(false), []);
  const open = useCallback(
    (target: string) => {
      setRing(false);
      bridge.openWindow(target);
    },
    [bridge],
  );

  const orbSize = orb.expanded ? 120 : 28;
  const orbHandlers = {
    onEnter: () => hits.enter("orb"),
    onLeave: () => hits.leave("orb"),
    onClick: () => {
      setRing((r) => !r);
      bridge.overlay?.orbClicked();
    },
    onContextMenu: () => {
      setRing(false);
      bridge.overlay?.orbMenu?.();
    },
  };
  return (
    <main className={`overlay${scenario ? " overlay-preview" : ""}`}>
      <div className="overlay-corner" style={{ "--orb-size": `${orbSize}px` } as CSSProperties}>
        {drop.dragging && (
          <ErrorBoundary name="drop">
            <DropRing orbSize={orbSize} />
          </ErrorBoundary>
        )}
        {ring && (
          <ErrorBoundary name="launcher">
            <Launcher orbSize={orbSize} onOpen={open} onClose={close} />
          </ErrorBoundary>
        )}
        <ErrorBoundary name="orb" fallback={<PlainOrb {...orbHandlers} />}>
          <Orb {...orb} {...orbHandlers} />
        </ErrorBoundary>
      </div>
      <ErrorBoundary name="cards">
        <CardsLayer
          bridge={bridge}
          hits={hits}
          pinned={
            drop.card && (
              <ErrorBoundary name="drop">
                <Hit hits={hits} id="drop-card">
                  <DropCard drop={drop} />
                </Hit>
              </ErrorBoundary>
            )
          }
        />
      </ErrorBoundary>
      <ErrorBoundary name="hands">
        <HandsLayer bridge={bridge} />
      </ErrorBoundary>
    </main>
  );
}

/** The orb with nothing live in it: what stays if the orb itself ever fails to render. */
function PlainOrb({ onEnter, onLeave, onClick }: { onEnter(): void; onLeave(): void; onClick(): void }) {
  return (
    <button
      type="button"
      className="orb"
      aria-label="JARVIS"
      data-orb-state="idle"
      onMouseEnter={onEnter}
      onMouseLeave={onLeave}
      onClick={onClick}
    >
      <span className="orb-core" />
    </button>
  );
}
