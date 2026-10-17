// Pure rules for the Mac's browser (JD-59): which addresses open, what Matthew's address bar turns
// into, and where a download lands. No electron import, so Vitest covers it.
import { basename, extname, join } from "node:path";

/** The Browser window's own profile: separate from the full views' persist:web (JD-39). */
export const BROWSER_PARTITION = "persist:browser";

/** A wrong or refused input to a browser action: its message goes back to the brain as it is. */
export class BrowserInputError extends Error {}

const SCHEME = /^[a-z][a-z0-9+.-]*:/i;
const HOST = /^(localhost|\d{1,3}(\.\d{1,3}){3}|([a-z0-9-]+\.)+[a-z][a-z0-9-]*)(:\d+)?([/?#].*)?$/i;
const LOCAL = /^(localhost|127\.\d+\.\d+\.\d+)(:\d+)?([/?#]|$)/i;

/** True for the pages a tab may show: http(s), and about:blank for a new tab. */
export function isBrowsable(url: string): boolean {
  if (url === "about:blank") return true;
  try {
    const { protocol } = new URL(url);
    return protocol === "https:" || protocol === "http:";
  } catch {
    return false;
  }
}

/** An address as a URL, or undefined when it isn't one ("example.com/a" → https://example.com/a). */
function asUrl(input: string): string | undefined {
  const text = input.trim();
  if (!text || /\s/.test(text)) return undefined;
  if (SCHEME.test(text) && !HOST.test(text)) return text;
  if (!HOST.test(text)) return undefined;
  return `${LOCAL.test(text) ? "http" : "https"}://${text}`;
}

/** What JARVIS asked to open, as a URL a tab may load; throws a readable sentence otherwise. */
export function openableUrl(input: unknown): string {
  if (typeof input !== "string" || !input.trim()) throw new BrowserInputError("open needs a url.");
  const url = asUrl(input);
  if (!url) throw new BrowserInputError(`“${input.trim()}” isn't a web address.`);
  if (!isBrowsable(url)) throw new BrowserInputError("Only http and https pages open in the browser.");
  return new URL(url).toString();
}

/** Matthew's address bar: a web address opens, anything else searches the web. */
export function addressToUrl(input: string): string | undefined {
  const text = input.trim();
  if (!text) return undefined;
  const url = asUrl(text);
  if (url && isBrowsable(url)) return new URL(url).toString();
  return `https://www.google.com/search?q=${encodeURIComponent(text)}`;
}

/** ~/Downloads/<name>, numbered like Finder ("report 2.pdf") when that file is already there. */
export function downloadPath(dir: string, filename: string, exists: (path: string) => boolean): string {
  const name = basename(filename.replace(/[\\/:]/g, "-")) || "download";
  const ext = extname(name);
  const stem = name.slice(0, name.length - ext.length) || "download";
  let candidate = join(dir, name);
  for (let n = 2; exists(candidate); n++) candidate = join(dir, `${stem} ${n}${ext}`);
  return candidate;
}

/** The tab strip's label for a page: its title, else its host, else "New tab". */
export function tabTitle(title: string, url: string): string {
  if (title.trim() && title !== url) return title.trim();
  try {
    const { hostname } = new URL(url);
    if (hostname) return hostname.replace(/^www\./, "");
  } catch {
    // Not a URL: a new tab.
  }
  return "New tab";
}
