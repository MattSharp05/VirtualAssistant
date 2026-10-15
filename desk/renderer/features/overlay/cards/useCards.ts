import { useCallback, useEffect, useReducer, useRef } from "react";
import type { DeskBridge, MoodResponse } from "@jarvis/shared";
import { cardsReducer, dndOn, initialCards, type CardsState } from "./model";

/** While notices are held back, how often to check whether Do Not Disturb is still on. */
export const DND_RECHECK_MS = 30_000;

/**
 * Do Not Disturb: the Desk's own setting (the tray's toggle, JD-26) when it has one, else the
 * server's (GET /mood). Unknown counts as off, so a notice is never lost to an error.
 */
export async function readDnd(bridge: DeskBridge): Promise<boolean> {
  const local = dndOn(await bridge.settings.get("dnd").catch(() => undefined));
  if (local !== undefined) return local;
  const mood = await bridge.request<MoodResponse>("/mood").catch(() => undefined);
  return dndOn(mood?.dnd) ?? false;
}

export interface CardsView extends CardsState {
  dismiss(key: string): void;
  /** Shows what Do Not Disturb held back. */
  release(): void;
}

/** The cards beside the orb, from the live stream (card.*, notice, timer.*). */
export function useCards(bridge: DeskBridge): CardsView {
  const [state, dispatch] = useReducer(cardsReducer, initialCards);
  // Notices wait for the DND check; this keeps them in arrival order behind each other.
  const chain = useRef<Promise<void>>(Promise.resolve());

  useEffect(() => {
    let alive = true;
    const off = bridge.subscribe((event) => {
      if (event.type === "notice") {
        chain.current = chain.current.then(async () => {
          const dnd = await readDnd(bridge);
          if (alive) dispatch({ type: "event", event, dnd, now: Date.now() });
        });
      } else if (event.type.startsWith("card.") || event.type.startsWith("timer.")) {
        dispatch({ type: "event", event, dnd: false, now: Date.now() });
      }
    });
    return () => {
      alive = false;
      off();
    };
  }, [bridge]);

  // Held-back notices come out once Do Not Disturb is turned off.
  const waiting = state.queued.length > 0;
  useEffect(() => {
    if (!waiting) return;
    let alive = true;
    const check = setInterval(() => {
      void readDnd(bridge).then((dnd) => {
        if (alive && !dnd) dispatch({ type: "release" });
      });
    }, DND_RECHECK_MS);
    return () => {
      alive = false;
      clearInterval(check);
    };
  }, [waiting, bridge]);

  const dismiss = useCallback((key: string) => dispatch({ type: "dismiss", key }), []);
  const release = useCallback(() => dispatch({ type: "release" }), []);
  return { ...state, dismiss, release };
}
