// The Browser window's state (JD-59): the toolbar from bridge.browser.state(), kept current by
// browser.state events; each browser.action shows its ring for RING_MS and its caption until it fades.
import { useEffect, useRef, useState } from "react";
import type { BrowserState, DeskBridge } from "@jarvis/shared";
import { CAPTION_MS, FADE_MS, RING_MS, type ShownAction } from "./model";

export function useBrowser(bridge: DeskBridge): { state?: BrowserState; action?: ShownAction } {
  const [state, setState] = useState<BrowserState>();
  const [action, setAction] = useState<ShownAction>();
  const seq = useRef(0);

  useEffect(() => {
    let alive = true;
    let heard = false;
    const timers: ReturnType<typeof setTimeout>[] = [];
    const later = (ms: number, fn: () => void) => timers.push(setTimeout(() => alive && fn(), ms));
    const off = bridge.subscribe((event) => {
      if (event.type === "browser.state") {
        heard = true;
        setState(event.state);
      } else if (event.type === "browser.action") {
        const n = ++seq.current;
        setAction({
          seq: n,
          caption: event.caption,
          ...(event.ref !== undefined ? { ref: event.ref } : {}),
          ...(event.rect ? { rect: event.rect } : {}),
          ring: event.ref !== undefined || !!event.rect,
          fading: false,
        });
        const mine = (fn: (a: ShownAction) => ShownAction | undefined) =>
          setAction((a) => (a && a.seq === n ? fn(a) : a));
        later(RING_MS, () => mine((a) => ({ ...a, ring: false })));
        later(CAPTION_MS, () => mine((a) => ({ ...a, fading: true })));
        later(CAPTION_MS + FADE_MS, () => mine(() => undefined));
      }
    });
    // An event that arrives first is newer than this answer.
    bridge.browser
      ?.state()
      .then((s) => alive && !heard && setState(s))
      .catch(() => {});
    return () => {
      alive = false;
      off();
      timers.forEach(clearTimeout);
    };
  }, [bridge]);

  return { ...(state ? { state } : {}), ...(action ? { action } : {}) };
}
