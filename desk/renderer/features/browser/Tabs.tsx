import type { BrowserTab } from "@jarvis/shared";
import { Icon } from "../../app/icons";

interface TabsProps {
  tabs: BrowserTab[];
  onSwitch(tabId: string): void;
  onClose(tabId: string): void;
  onNew(): void;
}

/** The tab strip: one active page, the others a click away; pages' new windows arrive here. */
export function Tabs({ tabs, onSwitch, onClose, onNew }: TabsProps) {
  return (
    <nav className="browser-tabs" aria-label="Tabs">
      {tabs.map((tab) => (
        <div key={tab.id} className="browser-tab" data-active={tab.active ? "" : undefined}>
          <button
            type="button"
            className="browser-tab-title"
            aria-current={tab.active ? "page" : undefined}
            title={tab.url}
            onClick={() => onSwitch(tab.id)}
          >
            <span className="browser-tab-dot" aria-hidden="true" />
            <span className="browser-tab-text">{tab.title || "New tab"}</span>
          </button>
          <button
            type="button"
            className="browser-tab-close"
            aria-label={`Close tab ${tab.title || "New tab"}`}
            onClick={() => onClose(tab.id)}
          >
            <Icon name="close" size={12} />
          </button>
        </div>
      ))}
      <button type="button" className="browser-tab-new" aria-label="New tab" title="New tab" onClick={onNew}>
        <Icon name="plus" size={14} />
      </button>
    </nav>
  );
}
