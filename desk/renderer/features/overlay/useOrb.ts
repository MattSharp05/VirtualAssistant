import { useEffect, useRef, useState } from "react";
import type { DeskBridge, Mood, OrbState } from "@jarvis/shared";

/** How long the orb stays large after going idle before shrinking back to the dot. */
export const SHRINK_AFTER_MS = 10_000;

export interface OrbView {
  state: OrbState;
  mood: Mood;
  amplitude: number;
  /** Large (120 px) while active and for 10 s after; the 28 px dot otherwise. */
  expanded: boolean;
}

/** The orb's state and mood from the live stream (orb.state, mood.changed). */
export function useOrb(bridge: DeskBridge): OrbView {
  const [view, setView] = useState<OrbView>({ state: "idle", mood: "green", amplitude: 0, expanded: false });
  const shrink = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    let alive = true;
    // The starting mood, unless a live mood.changed already arrived (that one is newer).
    let liveMood = false;
    bridge
      .request<{ mood: Mood }>("/mood")
      .then((m) => alive && !liveMood && setView((v) => ({ ...v, mood: m.mood })))
      .catch(() => undefined);
    const off = bridge.subscribe((e) => {
      if (e.type === "mood.changed") {
        liveMood = true;
        setView((v) => ({ ...v, mood: e.mood }));
      }
      if (e.type !== "orb.state") return;
      clearTimeout(shrink.current);
      if (e.state === "idle")
        shrink.current = setTimeout(() => setView((v) => ({ ...v, expanded: false })), SHRINK_AFTER_MS);
      setView((v) => ({
        ...v,
        state: e.state,
        amplitude: e.amplitude ?? 0,
        expanded: e.state === "idle" ? v.expanded : true,
      }));
    });
    return () => {
      alive = false;
      off();
      clearTimeout(shrink.current);
    };
  }, [bridge]);

  return view;
}
