// A full view (JD-39), shared by the Sessions and Notion windows: in the app, main lays the real site
// (claude.ai, notion.so) over this component's slot and keeps it there as the window resizes; leaving
// the tab hides it (still loaded). The web preview has no web views, so it shows a placeholder card.
import { useEffect, useRef, useState } from "react";
import { useBridge } from "./bridge";
import "./full-view.css";

const HINT_SEEN = "jarvis.fullViewHintSeen";

function hintSeen(): boolean {
  try {
    return localStorage.getItem(HINT_SEEN) === "1";
  } catch {
    return false;
  }
}

interface FullViewProps {
  /** The page to show; an https claude.ai or Notion link (main refuses anything else). */
  url: string;
  /** The site's name for the copy, e.g. "claude.ai". */
  site: string;
  /** What's open, e.g. the session or page title. */
  name: string;
}

export function FullView({ url, site, name }: FullViewProps) {
  const webview = useBridge().webview;
  const slot = useRef<HTMLDivElement>(null);
  const [showHint, setShowHint] = useState(() => !hintSeen());

  useEffect(() => {
    const el = slot.current;
    if (!webview || !el) return;
    const place = () => {
      const r = el.getBoundingClientRect();
      webview.show(url, { x: r.left, y: r.top, width: r.width, height: r.height });
    };
    place();
    const observer = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(place);
    observer?.observe(el);
    window.addEventListener("resize", place);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", place);
      webview.hide();
    };
  }, [webview, url]);

  if (!webview)
    return (
      <div className="full-view-placeholder">
        <div className="full-view-card">
          <h3>Full view works in the app</h3>
          <p>
            In JARVIS Desk this tab shows {site} itself, signed in, so you can do anything the site allows
            without leaving the window.
          </p>
          <a href={url} target="_blank" rel="noreferrer">
            Open “{name}” on {site}
          </a>
        </div>
      </div>
    );

  const dismiss = () => {
    setShowHint(false);
    try {
      localStorage.setItem(HINT_SEEN, "1");
    } catch {
      // Private storage: the hint comes back next time, nothing worse.
    }
  };

  return (
    <div className="full-view">
      {showHint && (
        <div className="full-view-hint" role="note">
          <p>Sign in once here; use email sign-in (Google sign-in may be blocked inside apps).</p>
          <button type="button" onClick={dismiss}>
            Got it
          </button>
        </div>
      )}
      <div ref={slot} className="full-view-slot" aria-label={`${name} on ${site}`} role="region">
        <p>Loading {site}…</p>
      </div>
    </div>
  );
}
