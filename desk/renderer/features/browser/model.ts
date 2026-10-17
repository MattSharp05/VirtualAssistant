// The Browser window's pure bits (JD-59): the status line, the address shown, and how long an action's
// ring and caption stay (the same timings main draws in the page, main/browser/actionOverlay.ts).
import type { BrowserRect, BrowserState } from "@jarvis/shared";

/** The ring around the element JARVIS is about to touch. */
export const RING_MS = 600;
/** The caption stays this long, then fades for FADE_MS. */
export const CAPTION_MS = 1_800;
export const FADE_MS = 600;

/** An action JARVIS announced (browser.action), as the window shows it right now. */
export interface ShownAction {
  /** Bumps per action, so a repeat of the same caption starts its timers again. */
  seq: number;
  caption: string;
  ref?: number;
  rect?: BrowserRect;
  ring: boolean;
  fading: boolean;
}

/** The toolbar's status line: who drives, then the task (or what the page is doing). */
export function statusLine(state: BrowserState): { who: string; text: string } {
  if (state.control === "matthew")
    return { who: "You", text: "You have the browser. JARVIS waits until you hand it back." };
  if (state.status) return { who: "JARVIS", text: state.status };
  if (state.loading) return { who: "JARVIS", text: "Loading…" };
  if (!state.tabs.length) return { who: "JARVIS", text: "Ready when you ask for something on the web." };
  return { who: "JARVIS", text: "Ready" };
}

/** What the address bar shows: the URL without https:// (about:blank as nothing). */
export function displayAddress(url: string): string {
  if (!url || url === "about:blank") return "";
  return url.replace(/^https:\/\//, "").replace(/^([^/?#]+)\/$/, "$1");
}

/** The site a URL is on, for the stand-in page and tab dots. */
export function siteOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}
