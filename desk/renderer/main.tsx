import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import type { DeskBridge } from "@jarvis/shared";
import { App } from "./app/App";
import { BridgeProvider, chooseBridge } from "./app/bridge";
import "./app/theme.css";

const native = (window as unknown as { desk?: DeskBridge }).desk;

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <BridgeProvider value={chooseBridge(window.location.search, native)}>
      <App />
    </BridgeProvider>
  </StrictMode>,
);
