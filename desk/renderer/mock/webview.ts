// The mock bridge's full views (JD-68), for scenarios that show them as in the app: no site is laid
// over the slot, but the sign-in state the scenario sets is reported, and pasted sign-in links are
// recorded (main loads them in the app).
import type { DeskBridge, FullViewSignIn } from "@jarvis/shared";
import { signInLink } from "../../main/windows/webPolicy";

export interface MockWebviewLog {
  /** Pages shown, and sign-in links opened, in order. */
  shown: string[];
  links: string[];
}

export function createMockWebview(
  signIn: FullViewSignIn,
  later: (ms: number, fn: () => void) => void,
): NonNullable<DeskBridge["webview"]> & MockWebviewLog {
  const shown: string[] = [];
  const links: string[] = [];
  return {
    shown,
    links,
    show: (url) => void (shown.at(-1) !== url && shown.push(url)),
    hide: () => {},
    // Like main: anything but an https claude.ai or Notion link is ignored.
    openLink: (url) => void (signInLink(url) && links.push(url)),
    onSignIn(fn) {
      let on = true;
      later(0, () => on && fn({ ...signIn }));
      return () => void (on = false);
    },
  };
}
