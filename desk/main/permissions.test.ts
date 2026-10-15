// @vitest-environment node
import type { DeskEvent } from "@jarvis/shared";
import { expect, it } from "vitest";
import {
  permissionCard,
  permissionFor,
  PRIVACY_PANES,
  RETRY_MS,
  startHotkeyWithAccess,
  type HotkeyAccessDeps,
} from "./permissions";

const at = new Date("2026-10-15T09:00:00Z");
const axError = Object.assign(new Error("Accessibility API is disabled"), {
  code: "UIOHOOK_ERROR_AXAPI_DISABLED",
});
const tapError = Object.assign(new Error("Failed to create event port."), {
  code: "UIOHOOK_ERROR_CREATE_EVENT_PORT",
});

function setup(failures: Error[], allowed = true) {
  const events: DeskEvent[] = [];
  let tick: (() => void) | undefined;
  let cleared = false;
  let starts = 0;
  const deps: HotkeyAccessDeps = {
    start: () => {
      starts++;
      const err = failures.shift();
      if (err) throw err;
    },
    allowed: () => allowed,
    publish: (e) => events.push(e),
    hint: () => "double-tap right ⌥",
    now: () => at,
    setInterval: (fn, ms) => {
      expect(ms).toBe(RETRY_MS);
      tick = fn;
      return 1;
    },
    clearInterval: () => void (cleared = true),
  };
  const stop = startHotkeyWithAccess(deps);
  return {
    events,
    stop,
    tick: () => tick?.(),
    get starts() {
      return starts;
    },
    get cleared() {
      return cleared;
    },
    setAllowed: (a: boolean) => (allowed = a),
  };
}

it("names the permission a failed start needs", () => {
  expect(permissionFor(axError)).toBe("accessibility");
  expect(permissionFor(tapError)).toBe("input-monitoring");
  expect(permissionFor("??")).toBe("input-monitoring");
});

it("the card has the steps and an Open Settings link to the pane", () => {
  const card = permissionCard("input-monitoring", "double-tap right ⌥", at);
  expect(card).toMatchObject({
    id: "voice-permission",
    title: "Let JARVIS hear your hotkey",
    link: { label: "Open Settings", url: PRIVACY_PANES["input-monitoring"] },
  });
  expect(card.body).toContain("To double-tap right ⌥ from any app");
  expect(card.body).toContain("- System Settings → **Privacy & Security**");
  expect(card.body).toContain("- **Input Monitoring** → turn on **JARVIS Desk**");
  expect(permissionCard("accessibility", "x", at).body).toContain("**Accessibility**");
});

it("starts at once when allowed: no card, no retries", () => {
  const t = setup([]);
  expect(t.starts).toBe(1);
  expect(t.events).toEqual([]);
  t.tick();
  expect(t.starts).toBe(1);
});

it("shows the card, retries in the background, and takes the card away once allowed", () => {
  const t = setup([tapError, tapError]);
  expect(t.events).toMatchObject([{ type: "card.show", card: { id: "voice-permission" } }]);
  t.tick(); // still failing: no second card
  expect(t.events).toHaveLength(1);
  t.tick();
  expect(t.starts).toBe(3);
  expect(t.events.at(-1)).toEqual({ type: "card.dismiss", id: "voice-permission" });
  expect(t.cleared).toBe(true);
});

it("doesn't retry (and re-prompt) until Accessibility is on", () => {
  const t = setup([axError], false);
  t.tick();
  t.tick();
  expect(t.starts).toBe(1);
  t.setAllowed(true);
  t.tick();
  expect(t.starts).toBe(2);
  expect(t.events.at(-1)).toEqual({ type: "card.dismiss", id: "voice-permission" });
  t.stop();
});
