import { useEffect, useState } from "react";
import type { DeskEvent } from "@jarvis/shared";
import { features } from "../features/registry";
import { useBridgeChoice } from "./bridge";
import { windowIdFromLocation } from "./router";

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
  const feature = features.find((f) => f.id === windowId);
  return feature ? <feature.component /> : <Placeholder />;
}
