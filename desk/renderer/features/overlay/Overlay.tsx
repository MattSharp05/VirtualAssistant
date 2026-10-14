import { useEffect, useMemo } from "react";
import { useBridgeChoice } from "../../app/bridge";
import { HitRegions } from "./hitRegions";
import { Orb } from "./Orb";
import { useOrb } from "./useOrb";
import "./overlay.css";

/** The see-through layer over every app, with the orb in the top-right corner. */
export function Overlay() {
  const { bridge, scenario } = useBridgeChoice();
  const orb = useOrb(bridge);
  const hits = useMemo(() => new HitRegions((on) => bridge.overlay?.setInteractive(on)), [bridge]);

  // The window itself must be see-through.
  useEffect(() => {
    document.documentElement.classList.add("overlay-window");
    return () => document.documentElement.classList.remove("overlay-window");
  }, []);

  return (
    <main className={`overlay${scenario ? " overlay-preview" : ""}`}>
      <div className="overlay-corner">
        <Orb
          {...orb}
          onEnter={() => hits.enter("orb")}
          onLeave={() => hits.leave("orb")}
          onClick={() => bridge.overlay?.orbClicked()}
        />
      </div>
    </main>
  );
}
