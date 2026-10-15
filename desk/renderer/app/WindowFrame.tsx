import type { ReactNode } from "react";
import { useBridge } from "./bridge";
import { Icon } from "./icons";
import "./window-frame.css";

interface WindowFrameProps {
  title: string;
  icon?: string;
  /** Buttons or controls for the title bar's right side, before minimise and close. */
  actions?: ReactNode;
  children: ReactNode;
}

/**
 * The glass frame every window shares (mockups 3–10): a 48 px title bar that drags the window, the
 * title, an actions slot, minimise and close. Resizing is native (edges and corners).
 */
export function WindowFrame({ title, icon, actions, children }: WindowFrameProps) {
  const bridge = useBridge();
  return (
    <div className="window-frame">
      <header className="window-titlebar">
        {icon && (
          <span className="window-icon">
            <Icon name={icon} size={16} />
          </span>
        )}
        <h1 className="window-title">{title}</h1>
        <div className="window-actions">{actions}</div>
        <div className="window-controls">
          <button type="button" aria-label="Minimise" onClick={() => bridge.frame?.minimize()}>
            <Icon name="minimize" size={14} />
          </button>
          <button
            type="button"
            className="window-close"
            aria-label="Close"
            onClick={() => bridge.frame?.close()}
          >
            <Icon name="close" size={14} />
          </button>
        </div>
      </header>
      <div className="window-body">{children}</div>
    </div>
  );
}
