// Key names for browser.press (JD-59) as the DevTools protocol's Input.dispatchKeyEvent wants them.
// "Enter", "ArrowDown", "a", "Meta+a", "Shift+Tab"; a few spoken aliases ("Return", "Esc", "Cmd").
import { BrowserInputError } from "./policy";

export interface KeyEvent {
  key: string;
  code: string;
  windowsVirtualKeyCode: number;
  /** What the key types (absent for keys that type nothing, or with ⌘/⌃ held). */
  text?: string;
  /** Alt 1, Control 2, Meta 4, Shift 8 (the protocol's bits). */
  modifiers: number;
}

const NAMED: Record<string, { key: string; code: string; vk: number; text?: string }> = {
  enter: { key: "Enter", code: "Enter", vk: 13, text: "\r" },
  tab: { key: "Tab", code: "Tab", vk: 9 },
  escape: { key: "Escape", code: "Escape", vk: 27 },
  backspace: { key: "Backspace", code: "Backspace", vk: 8 },
  delete: { key: "Delete", code: "Delete", vk: 46 },
  space: { key: " ", code: "Space", vk: 32, text: " " },
  arrowup: { key: "ArrowUp", code: "ArrowUp", vk: 38 },
  arrowdown: { key: "ArrowDown", code: "ArrowDown", vk: 40 },
  arrowleft: { key: "ArrowLeft", code: "ArrowLeft", vk: 37 },
  arrowright: { key: "ArrowRight", code: "ArrowRight", vk: 39 },
  home: { key: "Home", code: "Home", vk: 36 },
  end: { key: "End", code: "End", vk: 35 },
  pageup: { key: "PageUp", code: "PageUp", vk: 33 },
  pagedown: { key: "PageDown", code: "PageDown", vk: 34 },
};

const ALIASES: Record<string, string> = {
  return: "enter",
  esc: "escape",
  up: "arrowup",
  down: "arrowdown",
  left: "arrowleft",
  right: "arrowright",
  del: "delete",
  " ": "space",
};

const MODIFIERS: Record<string, number> = {
  alt: 1,
  option: 1,
  control: 2,
  ctrl: 2,
  meta: 4,
  cmd: 4,
  command: 4,
  shift: 8,
};

/** One key press for Input.dispatchKeyEvent; throws a readable sentence for a key it doesn't know. */
export function keyEvent(spec: unknown): KeyEvent {
  if (typeof spec !== "string" || !spec) throw new BrowserInputError("press needs a key, e.g. “Enter”.");
  // "+" alone (or a trailing "+", as in "Shift++") is the plus key itself.
  const parts = spec === "+" ? ["+"] : spec.split(/\+(?!$)/);
  const name = parts.pop()!;
  let modifiers = 0;
  for (const m of parts) {
    const bit = MODIFIERS[m.trim().toLowerCase()];
    if (!bit) throw new BrowserInputError(`“${m}” isn't a modifier (Shift, Control, Alt, Meta).`);
    modifiers |= bit;
  }
  const typesNothing = (modifiers & (2 | 4)) !== 0;
  const lower = name.toLowerCase();
  const named = NAMED[ALIASES[lower] ?? lower];
  if (named) {
    const text = named.text && !typesNothing ? named.text : undefined;
    return {
      key: named.key,
      code: named.code,
      windowsVirtualKeyCode: named.vk,
      modifiers,
      ...(text ? { text } : {}),
    };
  }
  if ([...name].length !== 1)
    throw new BrowserInputError(
      `“${name}” isn't a key I can press. Use one character or one of: ${Object.values(NAMED)
        .map((k) => (k.key === " " ? "Space" : k.key))
        .join(", ")}.`,
    );
  const shifted = (modifiers & 8) !== 0;
  const key = /[a-z]/i.test(name) ? (shifted ? name.toUpperCase() : name) : name;
  const upper = name.toUpperCase();
  const code = /[A-Z]/.test(upper) ? `Key${upper}` : /\d/.test(name) ? `Digit${name}` : "";
  const vk = /[A-Z0-9]/.test(upper) ? upper.charCodeAt(0) : 0;
  return {
    key,
    code,
    windowsVirtualKeyCode: vk,
    modifiers,
    ...(typesNothing ? {} : { text: key }),
  };
}
