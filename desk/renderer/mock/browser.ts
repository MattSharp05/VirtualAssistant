// The mock bridge's browser (JD-59): the Browser window's toolbar state from the scenario, and
// Matthew's toolbar commands answered as main would (take over, hand back, tabs, the address bar),
// each followed by a browser.state event. The page itself is the window's preview stand-in.
import type { BrowserCommand, BrowserState, DeskBridge, DeskEvent } from "@jarvis/shared";

export interface MockBrowserLog {
  /** Every toolbar command, in order (e2e checks them). */
  commands: BrowserCommand[];
}

/** No tabs yet: what a fresh Browser window shows. */
export const EMPTY_BROWSER: BrowserState = {
  tabs: [],
  url: "",
  title: "",
  canGoBack: false,
  canGoForward: false,
  loading: false,
  control: "jarvis",
};

function host(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

export function createMockBrowser(
  initial: BrowserState | undefined,
  emit: (event: DeskEvent) => void,
): NonNullable<DeskBridge["browser"]> & MockBrowserLog {
  let state: BrowserState = structuredClone(initial ?? EMPTY_BROWSER);
  let tabs = state.tabs.length;
  const commands: BrowserCommand[] = [];
  const set = (next: BrowserState) => {
    const active = next.tabs.find((t) => t.active);
    state = { ...next, url: active?.url ?? "", title: active?.title ?? "" };
    emit({ type: "browser.state", state: structuredClone(state) });
  };
  return {
    commands,
    state: async () => structuredClone(state),
    async command(command) {
      commands.push(command);
      switch (command.type) {
        case "take-over":
          return set({ ...state, control: "matthew" });
        case "hand-back":
          return set({ ...state, control: "jarvis" });
        case "go": {
          const text = command.address.trim();
          if (!text) return;
          const url = /^https?:\/\//.test(text) ? text : `https://${text}`;
          if (!state.tabs.length)
            state = { ...state, tabs: [{ id: `tab-${++tabs}`, url, title: "", active: true }] };
          return set({
            ...state,
            canGoBack: true,
            tabs: state.tabs.map((t) => (t.active ? { ...t, url, title: host(url) } : t)),
          });
        }
        case "new-tab":
          return set({
            ...state,
            tabs: [
              ...state.tabs.map((t) => ({ ...t, active: false })),
              { id: `tab-${++tabs}`, url: "about:blank", title: "New tab", active: true },
            ],
          });
        case "switch-tab":
          return set({ ...state, tabs: state.tabs.map((t) => ({ ...t, active: t.id === command.tabId })) });
        case "close-tab": {
          const i = state.tabs.findIndex((t) => t.id === command.tabId);
          if (i < 0) return;
          const left = state.tabs.filter((t) => t.id !== command.tabId);
          const wasActive = state.tabs[i]!.active;
          const next = wasActive ? (left[i] ?? left[i - 1]) : undefined;
          return set({
            ...state,
            tabs: left.map((t) => (next && t.id === next.id ? { ...t, active: true } : t)),
          });
        }
        default:
          // back / forward / reload: recorded; the stand-in page doesn't move.
          return;
      }
    },
    show: () => {},
    hide: () => {},
  };
}
