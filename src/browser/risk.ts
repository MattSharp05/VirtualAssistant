// Browser tasks' modes and risk rules (JD-60). A task runs in Normal mode unless Matthew asks for Full
// autonomy, either with the task box's switch or in the request itself ("do it on your own"). In
// Normal mode the brain asks before a step that commits (the prompt's rules below), and the Mac
// refuses a risky button without Matthew's approval anyway (desk/main/browser/guard.ts). Passwords,
// one-time codes and card details stop the task in both modes.
import type { BrowserTaskMode } from "@jarvis/shared";

/** "do it on your own", "full autonomy", "without asking me", "no need to ask"… */
const FULL =
  /\b(full(y)?[ -]?autonom(y|ous|ously)|(do|book|buy|order|handle|sort) (it|this|that|them)? ?(all )?(on your own|by yourself|yourself)|on your own|without (asking|checking with) me|without asking|(don'?t|no need to|you don'?t need to) (ask|check with) me|no need to (ask|check))\b/i;

/** The mode a request asks for: Full when its words say so, else the switch's (Normal by default). */
export function modeFromText(text: string, chosen?: BrowserTaskMode): BrowserTaskMode {
  if (chosen === "full") return "full";
  return FULL.test(text) ? "full" : "normal";
}

/** What the brain is told about the mode, in the task's first message. */
export function modeRules(mode: BrowserTaskMode): string {
  if (mode === "full")
    return "Mode: FULL AUTONOMY. Matthew said to do it on his own: do every step yourself, including buying, booking, sending, posting and deleting, without asking. Still never type a password, one-time code or card details: ask him to take over for those (browser_ask with kind \"takeover\").";
  return [
    "Mode: NORMAL. Browse, read, search and fill in forms freely, but ASK FIRST (browser_ask with kind \"approval\") before any step that:",
    "- buys or pays for something, or places an order;",
    "- books, reserves or confirms anything;",
    "- sends a message or an email, or posts, comments or publishes anything;",
    "- deletes or cancels something;",
    "- changes account settings (password, email, address, subscriptions).",
    "Say exactly what the step will do in the question (\"Book Lilia for 2 on Fri 23 Oct at 20:00, no deposit?\"). When he approves you get a token: pass it as `approval` to that one click.",
  ].join("\n");
}
