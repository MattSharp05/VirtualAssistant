import { useEffect, useState } from "react";
import { features } from "../features/registry";
import { windowIdFromHash } from "./router";

function Placeholder() {
  return (
    <main className="placeholder">
      <h1>JARVIS Desk</h1>
      <p>Nothing here yet. Windows arrive in later tickets.</p>
    </main>
  );
}

export function App() {
  const [windowId, setWindowId] = useState(() => windowIdFromHash(window.location.hash));
  useEffect(() => {
    const onHash = () => setWindowId(windowIdFromHash(window.location.hash));
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);
  const feature = features.find((f) => f.id === windowId);
  return feature ? <feature.component /> : <Placeholder />;
}
