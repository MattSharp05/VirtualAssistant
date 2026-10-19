// Pure rules for full views (JD-39): which sites load inside a window, where sign-in happens (JD-68),
// the browser JARVIS Desk claims to be, and the rect a renderer may ask for. No electron import, so
// Vitest covers it (and the renderer's "Sign in with a link" uses signInLink too).

/** The sites a full view shows: claude.ai and Notion (notion.so, and notion.com for newer links). */
const IN_PLACE = ["claude.ai", "notion.so", "notion.com"];

/** True for https links to claude.ai or Notion (or their subdomains): they load inside the full view. */
export function isInPlace(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== "https:") return false;
  const host = parsed.hostname.toLowerCase();
  return IN_PLACE.some((site) => host === site || host.endsWith(`.${site}`));
}

/** The identity providers claude.ai and Notion send Matthew to (JD-68). */
const SIGN_IN_HOSTS = ["accounts.google.com", "appleid.apple.com", "login.microsoftonline.com"];

/** claude.ai's and Notion's own sign-in pages, and their providers' callbacks. */
const AUTH_PATH =
  /^\/(login|logout|signup|sign-in|signin|magic-link|auth|oauth|sso|api\/auth|loginwith\w*|google\w*|apple\w*|microsoft\w*)(\/|$)/i;

function https(url: string): URL | undefined {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/** True for a sign-in page: Google, Apple or Microsoft sign-in, or claude.ai's or Notion's own. */
export function isSignIn(url: string): boolean {
  const parsed = https(url);
  if (!parsed) return false;
  if (SIGN_IN_HOSTS.includes(parsed.hostname.toLowerCase())) return true;
  return isInPlace(url) && AUTH_PATH.test(parsed.pathname);
}

/** True once a sign-in popup is back on claude.ai or Notion proper: signing in is done. */
export function isHome(url: string): boolean {
  return isInPlace(url) && !isSignIn(url);
}

/** Google refusing the embedded sign-in ("This browser or app may not be secure"). */
export function isGoogleBlocked(url: string): boolean {
  const parsed = https(url);
  return (
    parsed?.hostname.toLowerCase() === "accounts.google.com" &&
    /rejected|disallowed_useragent/i.test(parsed.pathname + parsed.search)
  );
}

/**
 * Where a link opened from a full view goes (window.open, target=_blank): sign-in pages to a small
 * sign-in window on the same login, claude.ai and Notion in place, other web and mail links to the
 * default browser.
 */
export function openTarget(url: string): "sign-in" | "in-place" | "browser" | "nowhere" {
  if (isSignIn(url)) return "sign-in";
  if (isInPlace(url)) return "in-place";
  return /^(https?|mailto):/i.test(url) ? "browser" : "nowhere";
}

/**
 * Whether a full view may follow a link in place (will-navigate): claude.ai, Notion and sign-in pages
 * stay; anything else goes to the default browser. Once on a sign-in page, its own hops are allowed
 * (providers bounce through hosts of their own before coming back).
 */
export function navigateTarget(url: string, from: string): "allow" | "browser" | "nowhere" {
  if (isInPlace(url) || isSignIn(url)) return "allow";
  if (!/^(https?|mailto):/i.test(url)) return "nowhere";
  return isSignIn(from) && /^https:/i.test(url) ? "allow" : "browser";
}

/** A sign-in link pasted from an email, cleaned up; undefined unless it's an https claude.ai or Notion link. */
export function signInLink(text: string): string | undefined {
  const url = text.trim();
  return isInPlace(url) ? new URL(url).toString() : undefined;
}

/**
 * The user agent of desktop Chrome on macOS at Electron's own Chromium version, so the sites treat a
 * full view as the browser it is (some refuse sign-in to agents that say "Electron").
 */
export function chromeUserAgent(chromeVersion: string): string {
  const major = chromeVersion.split(".")[0] || "140";
  return `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`;
}

export interface ViewBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** The renderer's rect as whole, non-negative pixels; undefined when it isn't a rect at all. */
export function viewBounds(input: unknown): ViewBounds | undefined {
  if (!input || typeof input !== "object") return undefined;
  const r = input as Record<string, unknown>;
  const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? Math.max(0, Math.round(v)) : NaN);
  const b = { x: n(r.x), y: n(r.y), width: n(r.width), height: n(r.height) };
  return Object.values(b).some(Number.isNaN) ? undefined : b;
}
