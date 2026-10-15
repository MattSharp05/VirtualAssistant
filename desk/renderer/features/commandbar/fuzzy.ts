// How well typed text matches a name (JD-28). Exact names beat prefixes, prefixes beat word starts and
// initials ("mk" → "Mario Kart"), and those beat letters merely in order. Case and accents are ignored.

/** Score bands, best first; a subsequence scores below SUBSTRING, less for each gap. */
const EXACT = 1000;
const PREFIX = 800;
const WORD_PREFIX = 600;
const INITIALS = 500;
const SUBSTRING = 400;
const SUBSEQUENCE = 300;

const fold = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();

/** The words of a name: split on spaces, punctuation and camelCase. */
function words(s: string): string[] {
  return fold(s.replace(/([a-z])([A-Z])/g, "$1 $2"))
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/** A score above 0 when `query` matches `text`; 0 when it doesn't. Shorter names win ties. */
export function fuzzyScore(query: string, text: string): number {
  const q = fold(query);
  const t = fold(text);
  if (!q || !t) return 0;
  // A small nudge for shorter names, so "mk" ranks above "mk-80-builder" within a band.
  const short = Math.max(0, 50 - t.length) / 100;
  if (t === q) return EXACT + short;
  if (t.startsWith(q)) return PREFIX + short;
  const ws = words(text);
  if (ws.some((w) => w.startsWith(q))) return WORD_PREFIX + short;
  if (
    ws
      .map((w) => w[0])
      .join("")
      .startsWith(q.replace(/\s+/g, ""))
  )
    return INITIALS + short;
  if (t.includes(q)) return SUBSTRING + short;
  // Every letter in order: fewer letters skipped between them is better.
  let at = -1;
  let gaps = 0;
  for (const ch of q.replace(/\s+/g, "")) {
    const next = t.indexOf(ch, at + 1);
    if (next < 0) return 0;
    if (at >= 0) gaps += next - at - 1;
    at = next;
  }
  return Math.max(1, SUBSEQUENCE - gaps * 5) + short;
}

/** The best score over several names of one thing (a session's name and its title). */
export function bestScore(query: string, texts: (string | undefined)[]): number {
  return Math.max(0, ...texts.map((t) => (t ? fuzzyScore(query, t) : 0)));
}
