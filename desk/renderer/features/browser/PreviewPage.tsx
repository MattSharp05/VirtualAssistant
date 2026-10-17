// The web preview's stand-in for the page (JD-59): the preview has no browser, so the Browser window
// draws a restaurant's booking page (or a placeholder for other sites) where the app lays the real
// one. Its elements carry the refs a snapshot would give them, so a scenario's browser.action rings
// the right one, as main does in the real page.
import { useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import type { BrowserRect } from "@jarvis/shared";
import type { ShownAction } from "./model";
import { siteOf } from "./model";

function BookingPage() {
  return (
    <div className="stand-in stand-in-booking">
      <header className="stand-in-header">
        <a href="#top" data-browser-ref="1" className="stand-in-brand" onClick={(e) => e.preventDefault()}>
          Taberna da Rua
        </a>
        <nav aria-label="Site">
          <a href="#menu" data-browser-ref="2" onClick={(e) => e.preventDefault()}>
            Menu
          </a>
          <a href="#book" data-browser-ref="3" onClick={(e) => e.preventDefault()}>
            Book
          </a>
        </nav>
      </header>
      <main className="stand-in-main">
        <h2>Book a table</h2>
        <p>Tables for up to 8, Tuesday to Sunday. Rua de São Miguel 24, Alfama.</p>
        <form className="stand-in-form" onSubmit={(e) => e.preventDefault()}>
          <label>
            Date
            <input data-browser-ref="11" defaultValue="Fri 23 Oct" readOnly />
          </label>
          <label>
            Party size
            <select data-browser-ref="12" defaultValue="4">
              {[2, 3, 4, 5, 6].map((n) => (
                <option key={n} value={n}>
                  {n} people
                </option>
              ))}
            </select>
          </label>
          <label>
            Time
            <select data-browser-ref="13" defaultValue="20:00">
              {["19:00", "19:30", "20:00", "20:30", "21:00"].map((t) => (
                <option key={t}>{t}</option>
              ))}
            </select>
          </label>
          <button type="submit" data-browser-ref="14">
            Check availability
          </button>
        </form>
        <p className="stand-in-note">
          We hold tables for 15 minutes. For groups over 8, call +351 21 000 0000.
        </p>
      </main>
    </div>
  );
}

function OtherPage({ url }: { url: string }) {
  return (
    <div className="stand-in stand-in-other">
      <h2>{siteOf(url) || "New tab"}</h2>
      <p>The preview's stand-in for this page. In JARVIS Desk the real page shows here.</p>
    </div>
  );
}

interface PreviewPageProps {
  url: string;
  action?: ShownAction;
}

/** The stand-in page, with the ring and caption of what JARVIS is doing on it. */
export function PreviewPage({ url, action }: PreviewPageProps) {
  const page = useRef<HTMLDivElement>(null);
  const [ring, setRing] = useState<BrowserRect>();
  const ref = action?.ref;
  const given = action?.rect;

  useLayoutEffect(() => {
    const root = page.current;
    const el = ref === undefined ? null : root?.querySelector(`[data-browser-ref="${ref}"]`);
    if (!root || !el) return setRing(given);
    const r = el.getBoundingClientRect();
    const p = root.getBoundingClientRect();
    setRing({ x: r.left - p.left, y: r.top - p.top, width: r.width, height: r.height });
  }, [ref, given, url]);

  const captionAt: CSSProperties = ring
    ? { left: ring.x + ring.width / 2, top: ring.y + ring.height + 12 }
    : { left: "50%", bottom: 24 };
  return (
    <div ref={page} className="browser-preview" role="region" aria-label="Page">
      {url.includes("reservas.example") ? <BookingPage /> : <OtherPage url={url} />}
      {action && (
        <div className="browser-act" data-fading={action.fading ? "" : undefined}>
          {action.ring && ring && (
            <div
              className="browser-ring"
              data-testid="browser-ring"
              style={{ left: ring.x - 4, top: ring.y - 4, width: ring.width + 8, height: ring.height + 8 }}
            />
          )}
          <div key={action.seq} className="browser-caption" role="status" style={captionAt}>
            {action.caption}
          </div>
        </div>
      )}
    </div>
  );
}
