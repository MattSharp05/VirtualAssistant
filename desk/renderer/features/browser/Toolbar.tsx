import { useState, type FormEvent } from "react";
import type { BrowserCommand, BrowserState } from "@jarvis/shared";
import { Icon } from "../../app/icons";
import { displayAddress, statusLine } from "./model";

interface ToolbarProps {
  state: BrowserState;
  onCommand(command: BrowserCommand): void;
}

/** Back, forward, reload, the address bar and Take over / Hand back; under them, the status line. */
export function Toolbar({ state, onCommand }: ToolbarProps) {
  // What Matthew is typing, for the page it was typed on: a new page puts its own address back.
  const [typed, setTyped] = useState<{ url: string; text: string }>();
  const draft = typed?.url === state.url ? typed.text : undefined;
  const setDraft = (text: string | undefined) =>
    setTyped(text === undefined ? undefined : { url: state.url, text });
  const matthew = state.control === "matthew";
  const status = statusLine(state);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const address = (draft ?? "").trim();
    if (address) onCommand({ type: "go", address });
    setDraft(undefined);
    (document.activeElement as HTMLElement | null)?.blur();
  };

  return (
    <div className="browser-chrome">
      <div className="browser-toolbar">
        <button
          type="button"
          className="browser-nav"
          aria-label="Back"
          title="Back"
          disabled={!state.canGoBack}
          onClick={() => onCommand({ type: "back" })}
        >
          <Icon name="back" size={16} />
        </button>
        <button
          type="button"
          className="browser-nav"
          aria-label="Forward"
          title="Forward"
          disabled={!state.canGoForward}
          onClick={() => onCommand({ type: "forward" })}
        >
          <Icon name="forward" size={16} />
        </button>
        <button
          type="button"
          className="browser-nav"
          aria-label="Reload"
          title="Reload"
          disabled={!state.tabs.length}
          onClick={() => onCommand({ type: "reload" })}
        >
          <Icon name="refresh" size={16} />
        </button>
        <form className="browser-address" role="search" onSubmit={submit}>
          <input
            type="text"
            aria-label="Address"
            placeholder="Search or type an address"
            spellCheck={false}
            autoComplete="off"
            value={draft ?? displayAddress(state.url)}
            onFocus={(e) => e.currentTarget.select()}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key !== "Escape") return;
              setDraft(undefined);
              e.currentTarget.blur();
            }}
          />
          {state.loading && <span className="browser-loading" aria-label="Loading" role="status" />}
        </form>
        <button
          type="button"
          className="browser-control"
          aria-pressed={matthew}
          title={matthew ? "Let JARVIS carry on" : "Stop JARVIS and drive yourself"}
          onClick={() => onCommand({ type: matthew ? "hand-back" : "take-over" })}
        >
          <Icon name={matthew ? "spark" : "hand"} size={15} />
          {matthew ? "Hand back" : "Take over"}
        </button>
      </div>
      <p className="browser-status" role="status" aria-label="Status">
        <span className="browser-status-who">{status.who}</span>
        <span className="browser-status-text">{status.text}</span>
      </p>
    </div>
  );
}
