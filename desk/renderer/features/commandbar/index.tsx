import { useCallback, useEffect, useMemo, useState, type KeyboardEvent } from "react";
import { useBridgeChoice } from "../../app/bridge";
import { Icon } from "../../app/icons";
import { buildResults, type CommandResult } from "./results";
import { useSources } from "./useSources";
import "./commandbar.css";

const ICONS: Record<CommandResult["kind"], string> = {
  window: "spark",
  session: "sessions",
  notion: "notion",
  layout: "layout",
  ask: "orb",
};
const KIND_HINT: Record<CommandResult["kind"], string> = {
  window: "Window",
  session: "Session",
  notion: "Notion",
  layout: "Layout",
  ask: "⌘↵",
};

/** What a row says, e.g. "Open session mk (Mario Kart orchestrator)". */
export function describeResult(r: CommandResult): string {
  switch (r.kind) {
    case "window":
      return `Open ${r.label}`;
    case "session":
      return `Open session ${r.label}${r.detail ? ` (${r.detail})` : ""}`;
    case "notion":
      return `Notion: ${r.label}`;
    case "layout":
      return `Layout: ${r.label}`;
    case "ask":
      return r.label;
  }
}

/**
 * The command bar (JD-28, mockup 2): type a window, a session, a Notion page or a layout, or ask JARVIS.
 * ↑↓ move, ↵ opens the highlighted row, ⌘↵ asks JARVIS, Esc closes. Main closes it when it loses focus.
 */
export default function CommandBar() {
  const { bridge, scenario } = useBridgeChoice();
  const [text, setText] = useState("");
  const [active, setActive] = useState(0);
  const [error, setError] = useState<string>();
  const sources = useSources(bridge, text);
  const results = useMemo(() => buildResults(text, sources), [text, sources]);
  const current = Math.min(active, results.length - 1);

  // The window is see-through around the bar.
  useEffect(() => {
    document.documentElement.classList.add("commandbar-window");
    document.title = "Command bar · JARVIS";
    return () => document.documentElement.classList.remove("commandbar-window");
  }, []);

  const close = useCallback(() => bridge.frame?.close(), [bridge]);

  const ask = useCallback(
    async (question: string) => {
      const q = question.trim();
      if (!q) return;
      try {
        await bridge.chat(q, "desk-typed");
        close();
      } catch (err) {
        setError(`Couldn't reach JARVIS: ${(err as Error).message}`);
      }
    },
    [bridge, close],
  );

  const run = useCallback(
    (r: CommandResult | undefined) => {
      if (!r) return;
      switch (r.kind) {
        case "window":
          bridge.openWindow(r.id);
          break;
        case "session":
          bridge.openWindow("sessions", { id: r.id });
          break;
        case "notion":
          bridge.openWindow("notion", { page: r.id });
          break;
        case "layout":
          for (const id of r.windows) bridge.openWindow(id);
          break;
        case "ask":
          return void ask(r.text);
      }
      close();
    },
    [bridge, ask, close],
  );

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      close();
    } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const step = e.key === "ArrowDown" ? 1 : -1;
      setActive((current + step + results.length) % results.length);
    } else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      void ask(text);
    } else if (e.key === "Enter" && e.target instanceof HTMLInputElement) {
      e.preventDefault();
      run(results[current]);
    }
  };

  return (
    <main
      className={`commandbar${scenario ? " commandbar-preview" : ""}`}
      onKeyDown={onKeyDown}
      // A click on the see-through part around the bar closes it, like a click on another app.
      onMouseDown={(e) => e.target === e.currentTarget && close()}
    >
      <section className="commandbar-panel" aria-label="Command bar">
        <div className="commandbar-field">
          <Icon name="search" size={20} />
          <input
            className="commandbar-input"
            aria-label="Ask JARVIS or open a window"
            placeholder="Open a window, a session, a Notion page… or ask JARVIS"
            role="combobox"
            aria-expanded="true"
            aria-controls="commandbar-results"
            aria-activedescendant={results[current] ? `commandbar-${current}` : undefined}
            autoFocus
            spellCheck={false}
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              setActive(0);
              setError(undefined);
            }}
          />
        </div>
        <div className="commandbar-results" id="commandbar-results" role="listbox" aria-label="Results">
          {results.map((r, i) => (
            <button
              key={r.key}
              id={`commandbar-${i}`}
              type="button"
              role="option"
              aria-selected={i === current}
              aria-label={describeResult(r)}
              className="commandbar-row"
              data-kind={r.kind}
              onMouseMove={() => i !== current && setActive(i)}
              onClick={() => run(r)}
            >
              <Icon name={r.kind === "window" ? r.icon : ICONS[r.kind]} />
              <span className="commandbar-label">
                <Label result={r} />
              </span>
              <span className="commandbar-hint">
                {r.kind === "ask" ? KIND_HINT.ask : i === current ? "↵" : KIND_HINT[r.kind]}
              </span>
            </button>
          ))}
        </div>
        {error && (
          <p className="commandbar-error" role="alert">
            {error}
          </p>
        )}
        <p className="commandbar-keys" aria-hidden="true">
          <span>↑↓ move</span>
          <span>↵ open</span>
          <span>⌘↵ ask JARVIS</span>
          <span>esc close</span>
        </p>
      </section>
    </main>
  );
}

function Label({ result: r }: { result: CommandResult }) {
  switch (r.kind) {
    case "window":
      return (
        <>
          Open <b>{r.label}</b>
        </>
      );
    case "session":
      return (
        <>
          Open session <b>{r.label}</b>
          {r.detail && <span className="commandbar-detail"> {r.detail}</span>}
        </>
      );
    case "notion":
      return <>Notion: {r.label}</>;
    case "layout":
      return (
        <>
          Layout: <b>{r.label}</b>
        </>
      );
    case "ask":
      return <>{r.label}</>;
  }
}
