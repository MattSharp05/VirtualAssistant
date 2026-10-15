// Spoken replies (JD-38) start with the first sentence, not the whole reply: SentenceSplitter takes
// brain.delta chunks as they stream and hands back each sentence once it's complete. A line break ends
// a sentence too (list items, headings, "Here's your day:"). A full stop isn't an ending after an
// abbreviation ("e.g.", "Dr."), inside a number ("3.5", "10.30") or a URL, or after a list's "1.";
// "a.m." and "etc." end one only before a capital. Fenced code blocks are skipped whole, and
// speakable() strips what shouldn't be read out: markdown, links' URLs, bare URLs, emoji. Pure.

/** Never end a sentence. */
const ABBREVIATIONS = new Set([
  "e.g", "i.e", "eg", "ie", "cf", "mr", "mrs", "ms", "dr", "prof", "sr", "jr", "st", "vs", "approx",
  "no", "fig", "mt", "ft", "est", "dept", "jan", "feb", "mar", "apr", "jun", "jul", "aug", "sep",
  "sept", "oct", "nov", "dec", "mon", "tue", "tues", "wed", "thu", "thur", "thurs", "fri", "sat", "sun",
]); // prettier-ignore
/** Often end a sentence: an ending only before a capital ("at 9 a.m. Then…" but "9 a.m. tomorrow"). */
const MAYBE_END = new Set(["etc", "inc", "ltd", "co", "am", "pm"]);

const TERMINATORS = ".!?…";
/** What may follow the terminator and still belong to the sentence: quotes, brackets, closing emphasis. */
const CLOSERS = `"'”’)]*_`;
const FENCE = /^\s*(```|~~~)/;

export class SentenceSplitter {
  /** Text not yet handed out (from the start of a line, or from just after the last sentence). */
  private pending = "";
  private atLineStart = true;
  private inCode = false;

  /** Feeds a chunk of the reply; returns the sentences it completed, ready to speak. */
  push(chunk: string): string[] {
    this.pending += chunk;
    return this.take(false);
  }

  /** The reply is done: whatever is left is the last sentence. Resets for the next reply. */
  flush(): string[] {
    const out = this.take(true);
    this.pending = "";
    this.atLineStart = true;
    this.inCode = false;
    return out;
  }

  private take(final: boolean): string[] {
    const out: string[] = [];
    for (;;) {
      const nl = this.pending.indexOf("\n");
      const whole = nl >= 0;
      const line = whole ? this.pending.slice(0, nl) : this.pending;
      if (this.atLineStart && FENCE.test(line) && (whole || final)) {
        this.inCode = !this.inCode;
        this.pending = whole ? this.pending.slice(nl + 1) : "";
        if (!whole) break;
        continue;
      }
      if (this.inCode) {
        // Inside a code block: drop whole lines, keep a partial one until it's known not to be the fence.
        if (!whole) {
          if (final) this.pending = "";
          break;
        }
        this.pending = this.pending.slice(nl + 1);
        this.atLineStart = true;
        continue;
      }
      // A line that may yet turn out to be a fence ("``") waits for its end.
      if (!whole && !final && this.atLineStart && /^\s*[`~]{0,2}$/.test(line) && line.trim()) break;
      const { sentences, rest } = splitLine(line, whole || final, this.atLineStart);
      out.push(...sentences.map(speakable).filter(Boolean));
      if (!whole) {
        this.atLineStart = this.atLineStart && rest === line;
        this.pending = rest;
        if (final && rest) {
          const last = speakable(rest);
          if (last) out.push(last);
          this.pending = "";
        }
        break;
      }
      const last = speakable(rest);
      if (last) out.push(last);
      this.pending = this.pending.slice(nl + 1);
      this.atLineStart = true;
    }
    return out;
  }
}

/**
 * The complete sentences in one line (or the start of one), and what's left after them. `complete`:
 * the line has ended, so an ending at its very end needn't wait to see what follows.
 */
export function splitLine(
  line: string,
  complete: boolean,
  lineStart = true,
): { sentences: string[]; rest: string } {
  const sentences: string[] = [];
  let start = 0;
  for (let i = 0; i < line.length; i++) {
    if (!TERMINATORS.includes(line[i]!)) continue;
    let j = i + 1;
    while (j < line.length && TERMINATORS.includes(line[j]!)) j++;
    while (j < line.length && CLOSERS.includes(line[j]!)) j++;
    if (j >= line.length) {
      if (complete) break; // the line's end ends it anyway
      // Can't tell yet: "3." may become "3.5". Wait for more.
      return { sentences, rest: line.slice(start) };
    }
    if (!/\s/.test(line[j]!)) {
      i = j - 1;
      continue; // "3.5", "example.com", "e.g"
    }
    if (line[i] === "." && j === i + 1) {
      const before = line.slice(start, i);
      const word = (/([A-Za-z.]+)$/.exec(before)?.[1] ?? "").toLowerCase();
      if (ABBREVIATIONS.has(word)) continue;
      // A list's "1." (at the start of the line), or an initial ("J. Smith").
      if (lineStart && start === 0 && /^\s*\d+$/.test(before)) continue;
      if (/(^|[\s(])[A-Z]$/.test(before)) continue;
      const acronym = /^([a-z]\.)+[a-z]$/.test(word); // "a.m", "u.s"
      if (acronym || MAYBE_END.has(word)) {
        const next = /\S/.exec(line.slice(j));
        if (!next) {
          if (complete) break;
          return { sentences, rest: line.slice(start) };
        }
        if (!/[A-Z]/.test(next[0])) continue;
      }
    }
    const sentence = line.slice(start, j).trim();
    if (sentence) sentences.push(sentence);
    while (j < line.length && /\s/.test(line[j]!)) j++;
    start = j;
    i = j - 1;
  }
  return { sentences, rest: complete ? line.slice(start).trim() : line.slice(start) };
}

/** One sentence as it should be heard: no markdown, URLs, HTML or emoji; "" when nothing's left to say. */
export function speakable(sentence: string): string {
  const text = sentence
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ") // images
    .replace(/\[([^\]]+)\]\([^)\s]*\)/g, "$1") // links → their text
    .replace(/<?\b(?:https?:\/\/|www\.)[^\s>)]*>?/gi, " ") // bare URLs
    .replace(/<\/?[a-z][^>]*>/gi, " ") // HTML tags
    .replace(/^\s*(?:#{1,6}\s+|>\s*|[-*+•]\s+|\d+[.)]\s+|\[[ xX]\]\s+)+/, "") // heading, quote, list, checkbox
    .replace(/^\s*\|?(?:\s*:?-{2,}:?\s*\|?)+\s*$/, "") // a table's |---|---| row, or a rule
    .replace(/^\s*\|\s*|\s*\|\s*$/g, "") // a table row's outer pipes…
    .replace(/\s*\|\s*/g, ", ") // …and its inner ones read as pauses
    .replace(/`([^`]*)`/g, "$1")
    .replace(/(\*\*|__|~~)(\S(?:.*?\S)?)\1/g, "$2")
    .replace(/(^|[^\w*])[*_](\S(?:.*?\S)?)[*_](?=[^\w*]|$)/g, "$1$2")
    .replace(/[*`#]+/g, " ")
    .replace(/\p{Extended_Pictographic}️?/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  return /[\p{L}\p{N}]/u.test(text) ? text : "";
}
