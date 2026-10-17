// The Mac's check on browser tasks' risky steps (JD-60), the second line after the brain's own prompt
// rules: before a click or typing in a task, main looks at the element itself. A click on a button
// whose words buy, book, pay, confirm, send, post, delete or place an order is refused in Normal mode
// unless the server passed Matthew's approval for it; typing into a password, one-time-code or card
// field is refused in both modes (Matthew types those himself: Take over, then Hand back). Pure, so the
// fixtures in guard.test.ts pin the rules down.
import { BROWSER_NEEDS_APPROVAL, BROWSER_NEEDS_MATTHEW, type BrowserTaskGrant } from "@jarvis/shared";
import { BrowserInputError } from "./policy";

/** What the guard knows about the element: the snapshot's role and name, and (fields) its DOM attributes. */
export interface GuardTarget {
  role: string;
  name: string;
  /** <input type>, e.g. "password", "submit". */
  inputType?: string;
  /** autocomplete, e.g. "cc-number", "one-time-code", "current-password". */
  autocomplete?: string;
  /** The button's value or the field's placeholder/id/name, when the accessible name is thin. */
  hints?: string[];
}

/** Roles a click on which can commit something. Links only navigate, so they're left to the prompt. */
const BUTTON_ROLES = new Set(["button", "menuitem", "menuitembutton", "PopUpButton"]);

/** Words on a button that commit: buy, book, pay, confirm, send, post, delete, place order… */
const RISKY_WORDS =
  /\b(pay(ment)?|pay now|buy|purchase|check ?out|book(ing)?|reserve|confirm|send|post|publish|tweet|delete|remove account|close account|cancel (my )?(subscription|account|booking|order)|place (the |my |your )?order|submit order|complete (order|purchase|booking)|subscribe|transfer|donate|save (changes|settings))\b/i;

/** Field names and autocomplete values for things only Matthew types. */
const PASSWORD = /\b(pass ?word|passcode|pass phrase|passphrase|pin)\b/i;
const ONE_TIME =
  /\b(one[- ]time|otp|2fa|two[- ]factor|verification code|security code sent|authenticat(ion|or) code|sms code|login code|6[- ]digit code)\b/i;
const CARD =
  /\b(card ?number|credit card|debit card|cc[- ]?num|cvc|cvv|cv2|security code|expir(y|ation)( date)?|exp(\.|iry)? ?date|mm ?\/ ?yy|cardholder|name on card|iban|sort code|account number)\b/i;
const CARD_AUTOCOMPLETE = /^cc-|\bcc-(number|csc|exp|exp-month|exp-year|name)\b/;

/** Why a field is one Matthew types himself, or undefined when JARVIS may type in it. */
export function secretField(t: GuardTarget): "password" | "one-time code" | "card details" | undefined {
  const type = (t.inputType ?? "").toLowerCase();
  const auto = (t.autocomplete ?? "").toLowerCase();
  const words = [t.name, ...(t.hints ?? [])].join(" ");
  if (type === "password" || /\b(current|new)-password\b/.test(auto)) return "password";
  if (auto.includes("one-time-code") || ONE_TIME.test(words)) return "one-time code";
  if (CARD_AUTOCOMPLETE.test(auto) || CARD.test(words)) return "card details";
  if (PASSWORD.test(words)) return "password";
  return undefined;
}

/** True when a click on this element could buy, book, send, post, delete or change an account. */
export function riskyClick(t: GuardTarget): boolean {
  const type = (t.inputType ?? "").toLowerCase();
  if (!BUTTON_ROLES.has(t.role) && type !== "submit") return false;
  return RISKY_WORDS.test([t.name, ...(t.hints ?? [])].join(" "));
}

/** The button's words as the refusal and the approval card say them. */
const what = (t: GuardTarget) => (t.name ? `‘${t.name.slice(0, 80)}’` : `the ${t.role}`);

/**
 * Throws the refusal for a click JARVIS may not make on its own: in a task's Normal mode (or outside
 * a task), a risky button without Matthew's approval. Full autonomy and an approved step pass.
 */
export function checkClick(t: GuardTarget, task: BrowserTaskGrant | undefined): void {
  if (!riskyClick(t)) return;
  if (task?.mode === "full") return;
  if (task?.approval) return;
  throw new BrowserInputError(
    `${BROWSER_NEEDS_APPROVAL}: clicking ${what(t)} could buy, book, send, post or delete something. Ask him first (browser_ask), then click with his approval.`,
  );
}

/** Throws for typing into a password, one-time-code or card field, in every mode and with any approval. */
export function checkType(t: GuardTarget): void {
  const secret = secretField(t);
  if (!secret) return;
  throw new BrowserInputError(
    `${BROWSER_NEEDS_MATTHEW}: ${what(t)} asks for ${secret === "card details" ? "card details" : `a ${secret}`}. Matthew enters it himself (Take over, then Hand back).`,
  );
}

/**
 * Reads the attributes the guard needs off the element (Runtime.callFunctionOn with this = it).
 * Returns { inputType, autocomplete, hints }.
 */
export const FIELD_INFO = `function () {
  const el = this;
  const attr = (n) => (el.getAttribute && el.getAttribute(n)) || "";
  const tag = (el.tagName || "").toLowerCase();
  return {
    inputType: tag === "input" ? String(el.type || "text") : tag === "button" ? String(el.type || "submit") : "",
    autocomplete: attr("autocomplete"),
    hints: [attr("name"), attr("id"), attr("placeholder"), attr("aria-label"), tag === "input" ? String(el.value || "") : ""]
      .filter(Boolean)
      .map((s) => String(s).slice(0, 80)),
  };
}`;

/** FIELD_INFO's answer as GuardTarget fields (anything odd is ignored). */
export function fieldInfo(value: unknown): Pick<GuardTarget, "inputType" | "autocomplete" | "hints"> {
  if (!value || typeof value !== "object") return {};
  const v = value as Record<string, unknown>;
  const hints = Array.isArray(v.hints) ? v.hints.filter((h): h is string => typeof h === "string") : [];
  return {
    ...(typeof v.inputType === "string" && v.inputType ? { inputType: v.inputType } : {}),
    ...(typeof v.autocomplete === "string" && v.autocomplete ? { autocomplete: v.autocomplete } : {}),
    ...(hints.length ? { hints } : {}),
  };
}
