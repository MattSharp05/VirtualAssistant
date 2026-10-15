import { useEffect, useState } from "react";
import type { DeskBridge } from "@jarvis/shared";
import { HandPointers, type HandPointer } from "./pointers";
import { startTracking, type TrackerState } from "./tracker";
import "./hands.css";

/** Camera hands (settings.cameraHands): read once, then again whenever main says it changed. */
export function useCameraHands(bridge: DeskBridge): boolean {
  const [on, setOn] = useState(false);
  useEffect(() => {
    let live = true;
    const read = () =>
      bridge.settings
        .get<boolean>("cameraHands")
        .then((v) => live && setOn(v === true))
        .catch(() => {});
    void read();
    const unsubscribe = bridge.subscribe((e) => {
      if (e.type === "settings.changed" && e.key === "cameraHands") void read();
    });
    return () => {
      live = false;
      unsubscribe();
    };
  }, [bridge]);
  return on;
}

interface LayerProps {
  bridge: DeskBridge;
  /** The camera + landmarker loop; tests pass a fake. */
  track?: typeof startTracking;
}

/**
 * The hand pointers over the whole overlay (JD-42, ADR 0012): while Camera hands is on, a ring at each
 * index fingertip and a dot at each thumb tip, following the camera (mirrored, smoothed). Turning it
 * off stops the camera. Never takes clicks; gestures arrive with JD-47.
 */
export function HandsLayer({ bridge, track = startTracking }: LayerProps) {
  const on = useCameraHands(bridge);
  const [state, setState] = useState<TrackerState>("stopped");
  const [error, setError] = useState<string>();
  const [pointers, setPointers] = useState<HandPointer[]>([]);

  useEffect(() => {
    if (!on) return;
    const model = new HandPointers();
    const tracking = track({
      onFrame: (hands, tMs) => {
        const next = model.update(hands, tMs, { width: window.innerWidth, height: window.innerHeight });
        // No hands, before or after: nothing to redraw.
        setPointers((prev) => (prev.length === 0 && next.length === 0 ? prev : next));
      },
      onState: (s, err) => {
        if (err) console.error("Camera hands:", err);
        setError(err ? String((err as Error).message ?? err) : undefined);
        setState(s);
      },
    });
    return () => {
      tracking.stop();
      setPointers([]);
    };
  }, [on, track]);

  if (!on) return null;
  return (
    <div className="hands-layer" data-hands-state={state} data-hands-error={error} aria-hidden="true">
      {pointers.map((p) => (
        <div key={p.hand} className={`hand${p.visible ? "" : " hand-faded"}`} data-hand={p.hand}>
          <span className="hand-ring" style={{ transform: `translate(${p.index.x}px, ${p.index.y}px)` }} />
          <span className="hand-dot" style={{ transform: `translate(${p.thumb.x}px, ${p.thumb.y}px)` }} />
        </div>
      ))}
    </div>
  );
}
