import { useCallback, useEffect, useMemo, useState, type CSSProperties } from "react";
import { useBridgeChoice } from "../../app/bridge";
import { HitRegions } from "./hitRegions";
import { Launcher } from "./Launcher";
import { Orb } from "./Orb";
import { useOrb } from "./useOrb";
import "./overlay.css";

/** The see-through layer over every app, with the orb in the top-right corner and its launcher ring. */
export function Overlay() {
  const { bridge, scenario, ui } = useBridgeChoice();
  const orb = useOrb(bridge);
  const hits = useMemo(() => new HitRegions((on) => bridge.overlay?.setInteractive(on)), [bridge]);
  const [ring, setRing] = useState(ui?.launcherOpen ?? false);

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
  return (
    <main className={`overlay${scenario ? " overlay-preview" : ""}`}>
      <div className="overlay-corner" style={{ "--orb-size": `${orbSize}px` } as CSSProperties}>
        {ring && <Launcher orbSize={orbSize} onOpen={open} onClose={close} />}
        <Orb
          {...orb}
          onEnter={() => hits.enter("orb")}
          onLeave={() => hits.leave("orb")}
          onClick={() => {
            setRing((r) => !r);
            bridge.overlay?.orbClicked();
          }}
        />
      </div>
    </main>
  );
}
