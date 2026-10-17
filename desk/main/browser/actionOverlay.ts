// What Matthew sees in the page as JARVIS acts (JD-59): a cyan ring around the element it's about to
// touch for RING_MS, then the action, and a caption pill ("Clicking ‘Check availability’") that fades.
// Drawn by a script evaluated in the page (the page is a native view, so the window can't draw on it):
// a <jarvis-action> element, aria-hidden (no snapshot reads it), click-through, in a closed shadow root
// on <html> (no page style reaches it, and body's text is unchanged).
import type { BrowserRect } from "@jarvis/shared";

/** How long the ring shows before JARVIS acts. */
export const RING_MS = 600;
/** How long the caption stays before it fades (the fade itself takes FADE_MS). */
export const CAPTION_MS = 1_800;
export const FADE_MS = 600;
/** The overlay's tag: page fingerprints leave it out. */
export const OVERLAY_TAG = "jarvis-action";

/** "Typing ‘Matthew Sharp’ into ‘Name’"; quoted bits stay short. */
export function short(s: string, max = 40): string {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
}

/** The expression for Runtime.evaluate that draws the ring (around `rect`, when given) and the caption. */
export function actionOverlayScript(caption: string, rect?: BrowserRect): string {
  const r = rect ? { x: rect.x, y: rect.y, w: rect.width, h: rect.height } : null;
  return `(() => {
  try {
    const caption = ${JSON.stringify(caption)};
    const r = ${JSON.stringify(r)};
    document.querySelectorAll(${JSON.stringify(OVERLAY_TAG)}).forEach((el) => el.remove());
    const host = document.createElement(${JSON.stringify(OVERLAY_TAG)});
    host.setAttribute("aria-hidden", "true");
    host.style.cssText = "position:fixed;inset:0;pointer-events:none;z-index:2147483647;";
    const root = host.attachShadow({ mode: "closed" });
    const font = "500 13px/1.3 -apple-system, BlinkMacSystemFont, 'Helvetica Neue', sans-serif";
    const cap = document.createElement("div");
    cap.textContent = caption;
    let top = innerHeight - 56, left = innerWidth / 2;
    if (r) {
      const ring = document.createElement("div");
      ring.style.cssText = "position:fixed;box-sizing:border-box;border:2px solid #5fd4e6;border-radius:8px;" +
        "box-shadow:0 0 0 4px rgba(95,212,230,.25),0 0 18px rgba(95,212,230,.55);transition:opacity .2s;" +
        "left:" + (r.x - 4) + "px;top:" + (r.y - 4) + "px;width:" + (r.w + 8) + "px;height:" + (r.h + 8) + "px;";
      root.append(ring);
      setTimeout(() => (ring.style.opacity = "0"), ${RING_MS});
      top = r.y + r.h + 12 < innerHeight - 40 ? r.y + r.h + 12 : Math.max(8, r.y - 42);
      left = Math.min(Math.max(r.x + r.w / 2, 140), innerWidth - 140);
    }
    cap.style.cssText = "position:fixed;transform:translateX(-50%);max-width:320px;padding:7px 12px;" +
      "border-radius:999px;background:rgba(14,19,24,.92);color:#e8eef2;border:1px solid rgba(95,212,230,.55);" +
      "box-shadow:0 6px 20px rgba(0,0,0,.35);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;" +
      "transition:opacity ${FADE_MS}ms;font:" + font + ";left:" + left + "px;top:" + top + "px;";
    root.append(cap);
    document.documentElement.append(host);
    setTimeout(() => (cap.style.opacity = "0"), ${CAPTION_MS});
    setTimeout(() => host.remove(), ${CAPTION_MS + FADE_MS});
  } catch {}
})()`;
}

/**
 * The page's fingerprint for "page changed" / "same page": where it is, its title and how much it
 * holds (the overlay left out).
 */
export const FINGERPRINT_SCRIPT = `(() => {
  const all = document.getElementsByTagName("*").length - document.getElementsByTagName(${JSON.stringify(OVERLAY_TAG)}).length;
  return [location.href, document.title, all, document.body ? document.body.innerText.length : 0].join("|");
})()`;
