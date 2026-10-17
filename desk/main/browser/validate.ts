// browser.* payloads (JD-59) checked before anything touches a page: what the brain sent, as the
// typed request, or a BrowserInputError whose sentence says what was wrong.
import {
  BROWSER_WAIT_MAX_MS,
  type BrowserCommand,
  type BrowserClickRequest,
  type BrowserNavigateRequest,
  type BrowserOpenRequest,
  type BrowserPressRequest,
  type BrowserScrollRequest,
  type BrowserSelectRequest,
  type BrowserSnapshotRequest,
  type BrowserStatusRequest,
  type BrowserTabsRequest,
  type BrowserTypeRequest,
  type BrowserWaitRequest,
} from "@jarvis/shared";
import { BrowserInputError, openableUrl } from "./policy";

/** Longest text browser.type sends in one go. */
export const MAX_TYPE_CHARS = 5_000;
export const MAX_STATUS_CHARS = 160;

const record = (payload: unknown): Record<string, unknown> =>
  payload && typeof payload === "object" && !Array.isArray(payload)
    ? (payload as Record<string, unknown>)
    : {};

const optionalBool = (v: unknown, field: string): boolean | undefined => {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "boolean") throw new BrowserInputError(`${field} should be true or false.`);
  return v;
};

const oneOf = <T extends string>(v: unknown, allowed: readonly T[], field: string): T => {
  if (typeof v === "string" && (allowed as readonly string[]).includes(v)) return v as T;
  throw new BrowserInputError(`${field} should be one of ${allowed.join(", ")}.`);
};

/** A snapshot ref: 12, "12" or "[12]". */
export function parseRef(v: unknown): number {
  const n =
    typeof v === "number" ? v : typeof v === "string" ? Number(v.trim().replace(/^\[(.*)\]$/, "$1")) : NaN;
  if (!Number.isInteger(n) || n < 1)
    throw new BrowserInputError("ref should be an element's number from the last snapshot, e.g. 12.");
  return n;
}

export function openRequest(payload: unknown): BrowserOpenRequest {
  const p = record(payload);
  const newTab = optionalBool(p.newTab, "newTab");
  return { url: openableUrl(p.url), ...(newTab !== undefined ? { newTab } : {}) };
}

export function navigateRequest(payload: unknown): BrowserNavigateRequest {
  return { action: oneOf(record(payload).action, ["back", "forward", "reload"] as const, "action") };
}

export function tabsRequest(payload: unknown): BrowserTabsRequest {
  const p = record(payload);
  const action = oneOf(p.action ?? "list", ["list", "switch", "close"] as const, "action");
  if (action === "list") return { action };
  if (typeof p.tabId !== "string" || !p.tabId) throw new BrowserInputError(`${action} needs a tabId.`);
  return { action, tabId: p.tabId };
}

export function snapshotRequest(payload: unknown): BrowserSnapshotRequest {
  const { more } = record(payload);
  if (more === undefined || more === null || more === "") return {};
  if (typeof more !== "string") throw new BrowserInputError("more should be the cursor a snapshot gave.");
  return { more };
}

export function clickRequest(payload: unknown): BrowserClickRequest {
  return { ref: parseRef(record(payload).ref) };
}

export function typeRequest(payload: unknown): BrowserTypeRequest {
  const p = record(payload);
  if (typeof p.text !== "string") throw new BrowserInputError("type needs text.");
  if (p.text.length > MAX_TYPE_CHARS)
    throw new BrowserInputError(`type takes up to ${MAX_TYPE_CHARS} characters at a time.`);
  const submit = optionalBool(p.submit, "submit");
  return { ref: parseRef(p.ref), text: p.text, ...(submit !== undefined ? { submit } : {}) };
}

export function selectRequest(payload: unknown): BrowserSelectRequest {
  const p = record(payload);
  if (typeof p.option !== "string" || !p.option.trim())
    throw new BrowserInputError("select needs the option's label or value.");
  return { ref: parseRef(p.ref), option: p.option };
}

export function pressRequest(payload: unknown): BrowserPressRequest {
  const { key } = record(payload);
  if (typeof key !== "string" || !key) throw new BrowserInputError("press needs a key, e.g. “Enter”.");
  return { key };
}

export function scrollRequest(payload: unknown): BrowserScrollRequest {
  const p = record(payload);
  if (p.ref !== undefined && p.ref !== null) return { ref: parseRef(p.ref) };
  return { direction: oneOf(p.direction ?? "down", ["up", "down", "top", "bottom"] as const, "direction") };
}

export function waitRequest(payload: unknown): BrowserWaitRequest {
  const p = record(payload);
  if (typeof p.text === "string" && p.text.trim()) return { text: p.text.trim() };
  if (typeof p.ms === "number" && Number.isFinite(p.ms) && p.ms >= 0)
    return { ms: Math.min(Math.round(p.ms), BROWSER_WAIT_MAX_MS) };
  throw new BrowserInputError(`wait needs text to wait for, or ms (up to ${BROWSER_WAIT_MAX_MS}).`);
}

export function statusRequest(payload: unknown): BrowserStatusRequest {
  const { text } = record(payload);
  if (text === undefined || text === null) return {};
  if (typeof text !== "string") throw new BrowserInputError("status text should be a string.");
  const one = text.replace(/\s+/g, " ").trim().slice(0, MAX_STATUS_CHARS);
  return one ? { text: one } : {};
}

const COMMANDS = ["back", "forward", "reload", "new-tab", "take-over", "hand-back"] as const;

/** A toolbar command from the Browser window's renderer, or undefined when it isn't one. */
export function browserCommand(input: unknown): BrowserCommand | undefined {
  const p = record(input);
  const type = p.type;
  if (type === "go")
    return typeof p.address === "string" ? { type, address: p.address.slice(0, 4_000) } : undefined;
  if (type === "switch-tab" || type === "close-tab")
    return typeof p.tabId === "string" && p.tabId ? { type, tabId: p.tabId } : undefined;
  return (COMMANDS as readonly unknown[]).includes(type)
    ? { type: type as (typeof COMMANDS)[number] }
    : undefined;
}
