// macOS privacy permissions the Desk needs beyond the microphone: push-to-talk's key hook (uiohook-napi,
// voice/hotkey.ts) only starts once JARVIS Desk is allowed to see keys from other apps (Input
// Monitoring, and Accessibility, which libuiohook asks for itself). Until then a card beside the orb
// says where to switch it on, with an Open Settings link, and the hook is retried in the background,
// so it starts by itself once allowed. Pure apart from the injected start/publish/timers: tested with fakes.
import type { DeskEvent, ScreenCard } from "@jarvis/shared";

export type HotkeyPermission = "input-monitoring" | "accessibility";

export const PERMISSION_CARD_ID = "voice-permission";
export const RETRY_MS = 5_000;

/** System Settings, opened at the right Privacy & Security pane. */
export const PRIVACY_PANES: Record<HotkeyPermission, string> = {
  "input-monitoring": "x-apple.systempreferences:com.apple.preference.security?Privacy_ListenEvent",
  accessibility: "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility",
};

const PANE_NAMES: Record<HotkeyPermission, string> = {
  "input-monitoring": "Input Monitoring",
  accessibility: "Accessibility",
};

/** Which permission a failed hook start points at: libuiohook names Accessibility; anything else is the event tap. */
export function permissionFor(err: unknown): HotkeyPermission {
  const text = err instanceof Error ? `${(err as { code?: string }).code ?? ""} ${err.message}` : String(err);
  return /AXAPI|accessibility/i.test(text) ? "accessibility" : "input-monitoring";
}

/** The first-run card: the steps, and a link that opens the pane. `hint` is how push-to-talk is started. */
export function permissionCard(permission: HotkeyPermission, hint: string, at: Date): ScreenCard {
  const pane = PANE_NAMES[permission];
  return {
    id: PERMISSION_CARD_ID,
    createdAt: at.toISOString(),
    title: "Let JARVIS hear your hotkey",
    body: [
      `To ${hint} from any app, macOS has to let JARVIS Desk see that key.`,
      "",
      "- System Settings → **Privacy & Security**",
      `- **${pane}** → turn on **JARVIS Desk**`,
      "",
      "Push-to-talk starts by itself once it's on. Until then, ⌘⌥L talks to JARVIS too.",
    ].join("\n"),
    kind: "text",
    link: { label: "Open Settings", url: PRIVACY_PANES[permission] },
  };
}

export interface HotkeyAccessDeps {
  /** Starts the key hook; throws while macOS doesn't allow it. */
  start(): void;
  /**
   * Whether trying again is worth it without prompting (Accessibility: Electron's
   * isTrustedAccessibilityClient(false); libuiohook would otherwise show macOS's prompt each time).
   */
  allowed(permission: HotkeyPermission): boolean;
  publish(event: DeskEvent): void;
  /** How push-to-talk is started, for the card ("double-tap right ⌥"). */
  hint(): string;
  now?: () => Date;
  setInterval?: (fn: () => void, ms: number) => unknown;
  clearInterval?: (handle: unknown) => void;
}

/**
 * Starts the hook, or shows the permission card and keeps retrying until macOS allows it (then the card
 * goes). Returns a function that stops retrying.
 */
export function startHotkeyWithAccess(deps: HotkeyAccessDeps): () => void {
  const now = deps.now ?? (() => new Date());
  const every = deps.setInterval ?? ((fn, ms) => setInterval(fn, ms));
  const clear = deps.clearInterval ?? ((h) => clearInterval(h as ReturnType<typeof setInterval>));
  let missing: HotkeyPermission | undefined;
  let timer: unknown;

  const attempt = (): boolean => {
    try {
      deps.start();
    } catch (err) {
      const permission = permissionFor(err);
      if (permission !== missing) {
        missing = permission;
        console.warn(`push-to-talk: waiting for ${PANE_NAMES[permission]}`);
        deps.publish({ type: "card.show", card: permissionCard(permission, deps.hint(), now()) });
      }
      return false;
    }
    if (missing) deps.publish({ type: "card.dismiss", id: PERMISSION_CARD_ID });
    missing = undefined;
    return true;
  };

  if (attempt()) return () => {};
  timer = every(() => {
    if (missing && !deps.allowed(missing)) return;
    if (attempt()) {
      clear(timer);
      timer = undefined;
    }
  }, RETRY_MS);
  return () => {
    if (timer !== undefined) clear(timer);
    timer = undefined;
  };
}
