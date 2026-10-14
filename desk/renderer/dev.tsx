// dev.html: every scenario × every window as a link (the QA block links here).
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { DevIndex } from "./mock/DevIndex";
import "./app/theme.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <DevIndex />
  </StrictMode>,
);
