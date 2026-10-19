// A full view (JD-39), shared by the Sessions and Notion windows: in the app, main lays the real site
// (claude.ai, notion.so) over this component's slot and keeps it there as the window resizes; leaving
// the tab hides it (still loaded). The web preview has no web views, so it shows a placeholder card.
// The hint bar (JD-68) shows on first use and whenever the page is on a sign-in page: "Sign in with a
// link" takes the link from a sign-in email, pasted, since clicking it opens the default browser.
import { useEffect, useRef, useState, type FormEvent } from "react";
import type { FullViewSignIn } from "@jarvis/shared";
import { signInLink } from "../../main/windows/webPolicy";
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

const NOT_SIGNING_IN: FullViewSignIn = { signInPage: false, googleBlocked: false };

export function FullView({ url, site, name }: FullViewProps) {
  const webview = useBridge().webview;
  const slot = useRef<HTMLDivElement>(null);
  const [showHint, setShowHint] = useState(() => !hintSeen());
  const [signIn, setSignIn] = useState<FullViewSignIn>(NOT_SIGNING_IN);
  const [linkOpen, setLinkOpen] = useState(false);
  const [link, setLink] = useState("");
  const [linkError, setLinkError] = useState<string>();

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

  // The hint comes back when the page lands on a sign-in page, or Google refuses to sign in here.
  const last = useRef(NOT_SIGNING_IN);
  useEffect(
    () =>
      webview?.onSignIn?.((next) => {
        const prev = last.current;
        last.current = next;
        if ((next.signInPage && !prev.signInPage) || (next.googleBlocked && !prev.googleBlocked))
          setShowHint(true);
        setSignIn(next);
      }),
    [webview],
  );

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
    setLinkOpen(false);
    try {
      localStorage.setItem(HINT_SEEN, "1");
    } catch {
      // Private storage: the hint comes back next time, nothing worse.
    }
  };

  const closeLink = () => {
    setLinkOpen(false);
    setLink("");
    setLinkError(undefined);
  };

  const submitLink = (e: FormEvent) => {
    e.preventDefault();
    const target = signInLink(link);
    if (!target)
      return setLinkError(
        "Paste the whole link from the email: it starts with https://claude.ai or a Notion address.",
      );
    webview.openLink?.(target);
    closeLink();
  };

  const canPaste = Boolean(webview.openLink);
  return (
    <div className="full-view">
      {showHint && (
        <div
          className="full-view-hint"
          role="note"
          aria-label="Signing in"
          data-blocked={signIn.googleBlocked || undefined}
        >
          <div className="full-view-hint-row">
            <p>
              {signIn.googleBlocked
                ? "Google won't sign in inside the app: use email sign-in instead. "
                : "Sign in once here and it stays signed in; Google and Apple open a small sign-in window. "}
              {canPaste &&
                "Email link? Copy it from the email (don't click it, it opens your browser) and paste it here."}
            </p>
            {canPaste && !linkOpen && (
              <button type="button" className="is-primary" onClick={() => setLinkOpen(true)}>
                Sign in with a link
              </button>
            )}
            <button type="button" onClick={dismiss}>
              Got it
            </button>
          </div>
          {linkOpen && (
            <form className="full-view-link" onSubmit={submitLink} noValidate>
              <input
                type="url"
                inputMode="url"
                spellCheck={false}
                autoComplete="off"
                autoFocus
                aria-label="Sign-in link from the email"
                aria-invalid={Boolean(linkError)}
                aria-describedby={linkError ? "full-view-link-error" : undefined}
                placeholder={`https://${site}/…`}
                value={link}
                onChange={(e) => {
                  setLink(e.currentTarget.value);
                  setLinkError(undefined);
                }}
                onKeyDown={(e) => e.key === "Escape" && closeLink()}
              />
              <button type="submit" className="is-primary">
                Open link
              </button>
              <button type="button" onClick={closeLink}>
                Cancel
              </button>
              {linkError && (
                <p id="full-view-link-error" className="full-view-link-error" role="alert">
                  {linkError}
                </p>
              )}
            </form>
          )}
        </div>
      )}
      <div ref={slot} className="full-view-slot" aria-label={`${name} on ${site}`} role="region">
        <p>Loading {site}…</p>
      </div>
    </div>
  );
}
