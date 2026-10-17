import { useEffect, useRef } from "react";
import type { DeskBridge } from "@jarvis/shared";

/**
 * Where the real page goes in the app: main lays the active tab's view over this rect and keeps it
 * there as the window resizes (like full views, app/FullView.tsx). Unmounting hides it.
 */
export function PageSlot({ browser }: { browser: NonNullable<DeskBridge["browser"]> }) {
  const slot = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = slot.current;
    if (!el) return;
    const place = () => {
      const r = el.getBoundingClientRect();
      browser.show({ x: r.left, y: r.top, width: r.width, height: r.height });
    };
    place();
    const observer = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(place);
    observer?.observe(el);
    window.addEventListener("resize", place);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", place);
      browser.hide();
    };
  }, [browser]);
  return (
    <div ref={slot} className="browser-slot" role="region" aria-label="Page">
      <p>Loading the page…</p>
    </div>
  );
}
