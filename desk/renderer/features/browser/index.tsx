// The Browser window (JD-59): pages JARVIS acts in on the Mac, which Matthew can watch and take over.
// Tabs, then the toolbar (back, forward, reload, address, Take over / Hand back) and the task's status
// line, then the page: in the app main lays the real one over the slot; the web preview draws a
// stand-in with the ring and caption of each action.
import type { BrowserCommand } from "@jarvis/shared";
import { useBridgeChoice } from "../../app/bridge";
import { PageSlot } from "./PageSlot";
import { PreviewPage } from "./PreviewPage";
import { Tabs } from "./Tabs";
import { Toolbar } from "./Toolbar";
import { useBrowser } from "./useBrowser";
import "./browser.css";

function NoPage() {
  return (
    <div className="browser-empty">
      <h2>No page open</h2>
      <p>
        When you ask JARVIS to do something on the web, it opens the page here so you can watch, and take over
        whenever you like. You can also type an address above.
      </p>
    </div>
  );
}

export default function BrowserWindow() {
  const { bridge, scenario } = useBridgeChoice();
  const { state, action } = useBrowser(bridge);
  const browser = bridge.browser;
  if (!browser)
    return (
      <div className="browser-empty">
        <h2>The browser works in the app</h2>
      </div>
    );
  if (!state) return <div className="browser" aria-busy="true" />;

  const command = (c: BrowserCommand) => void browser.command(c).catch(() => {});
  const active = state.tabs.find((t) => t.active);
  return (
    <div className="browser" data-control={state.control}>
      <Tabs
        tabs={state.tabs}
        onSwitch={(tabId) => command({ type: "switch-tab", tabId })}
        onClose={(tabId) => command({ type: "close-tab", tabId })}
        onNew={() => command({ type: "new-tab" })}
      />
      <Toolbar state={state} onCommand={command} />
      <div className="browser-page">
        {!active ? (
          <NoPage />
        ) : scenario !== undefined ? (
          <PreviewPage url={active.url} {...(action ? { action } : {})} />
        ) : (
          <PageSlot browser={browser} />
        )}
      </div>
    </div>
  );
}
