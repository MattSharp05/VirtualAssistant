import { useEffect, useState } from "react";
import type { DeskEvent } from "@jarvis/shared";
import { findFeature, type Feature } from "../features/registry";
import { DEFAULT_SIZE } from "../features/types";
import { useBridgeChoice } from "./bridge";
import { windowIdFromLocation } from "./router";
import { WindowFrame } from "./WindowFrame";
import { WindowTitleContext } from "./windowTitle";

function describe(event: DeskEvent): string {
  return event.type === "notice" ? `${event.type}: ${event.title}` : event.type;
}

function Placeholder() {
  const { bridge, scenario } = useBridgeChoice();
  const [last, setLast] = useState<string>();
  useEffect(() => bridge.subscribe((e) => setLast(describe(e))), [bridge]);
  return (
    <main className="placeholder">
      <h1>JARVIS Desk</h1>
      <p>Nothing here yet. Windows arrive in later tickets.</p>
      {scenario && (
        <p className="placeholder-meta" data-testid="scenario">
          Preview scenario: <strong>{scenario}</strong>
          {last ? ` · last event: ${last}` : ""}
        </p>
      )}
    </main>
  );
}

export function App() {
  const [windowId, setWindowId] = useState(() => windowIdFromLocation(window.location));
  useEffect(() => {
    const onHash = () => setWindowId(windowIdFromLocation(window.location));
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);
  const feature = findFeature(windowId);
  if (!feature) return <Placeholder />;
  return feature.framed === false ? <feature.component /> : <Framed feature={feature} />;
}

/** A feature in the glass frame; the page itself is see-through (the preview fakes a desktop). */
function Framed({ feature }: { feature: Feature }) {
  const { scenario } = useBridgeChoice();
  useEffect(() => {
    const root = document.documentElement;
    const classes = ["framed-window", ...(scenario ? ["preview"] : [])];
    root.classList.add(...classes);
    // The preview shows the window at its default size on a fake desktop.
    const size = feature.defaultSize ?? DEFAULT_SIZE;
    root.style.setProperty("--window-width", `${size.width}px`);
    root.style.setProperty("--window-height", `${size.height}px`);
    return () => root.classList.remove(...classes);
  }, [feature, scenario]);
  // A feature may name its window after what it shows (useWindowTitle).
  const [own, setOwn] = useState<string>();
  const title = own ?? feature.title;
  useEffect(() => {
    document.title = `${title} · JARVIS`;
  }, [title]);
  return (
    <WindowTitleContext.Provider value={setOwn}>
      <WindowFrame title={title} icon={feature.icon}>
        <feature.component />
      </WindowFrame>
    </WindowTitleContext.Provider>
  );
}
