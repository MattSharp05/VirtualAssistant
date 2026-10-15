// Pure rules for full views (JD-39): which sites load inside a window, the browser JARVIS Desk claims
// to be, and the rect a renderer may ask for. No electron import, so Vitest covers it.

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

/** Where a link opened from a full view goes (window.open, target=_blank). */
export function openTarget(url: string): "in-place" | "browser" | "nowhere" {
  if (isInPlace(url)) return "in-place";
  return /^(https?|mailto):/i.test(url) ? "browser" : "nowhere";
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
