# 0013 — Browser handoff: shared login state, and taking over Matthew's real Chrome

**Status.** Phase 1 (below) implemented. Phase 2 is a recommendation, not yet built: it adds a new
component (a Chrome extension) with real access to Matthew's everyday browser, so it waits on his
sign-off on the approach before more code lands.

**Context.** The Browser window (JD-59/60) already has its own persistent Chromium profile
(`persist:browser`, `desk/main/browser/policy.ts`), separate from the `persist:web` profile the Sessions
and Notion full views share (JD-39). Matthew's friction has three parts:
1. No convenient way to get to the Browser window from wherever he already is.
2. The `persist:browser` profile starts out signed into nothing, and some sites (Instagram among them)
   actively resist a fresh/automated-looking sign-in even when Matthew types the password himself.
3. He often wants to hand JARVIS a task that's already underway in his *real* Chrome, with its own
   cookies and sessions, not re-start it from a blank profile.

**Options considered.**
- **A — Persistent profile, logged in once.** Already half-true: `persist:browser` survives restarts,
  and the toolbar's address bar works whoever has control (`host.ts` `command()`), so Matthew can open
  the window any time and sign in by hand, same as the existing `persist:web` sign-in flow (JD-68).
  Zero new surface, but doesn't solve (3), and friction (2) remains for any site whose bot-detection
  flags a browser it's never seen before, however the login happened.
- **B — Chrome's remote-debugging port, attach to Matthew's real Chrome.** Rejected. It needs Chrome
  relaunched with `--remote-debugging-port` to attach at all (closing his tabs), and the port is a bare
  TCP socket with full control of the browser and every cookie in it — a severe, standing attack surface
  if anything on the Mac or a page (DNS rebinding) reaches it. Not worth it next to C.
- **C — A small Chrome extension using `chrome.debugger`.** An extension with the `debugger` permission
  can attach the DevTools protocol to one tab it's given — no relaunch, no open port — which is exactly
  the protocol `BrowserAgent` already drives (`desk/main/browser/agent.ts` takes a `Cdp` and a
  `BrowserTabsHost`; "No Electron in here" by design). Chrome shows its own "is being debugged" banner
  on that tab the whole time, so Matthew always sees when JARVIS has it. The extension would need a
  local connection out to the Desk app (a `ws://127.0.0.1:<port>` the Desk app already runs would do; no
  native-messaging-host install) and a new `ExtensionBrowserHost` implementing `BrowserTabsHost` —
  the agent, guard, snapshot and policy layers stay as they are.
- **D — Cookie/profile import into `persist:browser`.** Rejected as the main path: copying Chrome's
  cookie store needs Matthew's OS keychain to decrypt it and goes stale the moment he re-authenticates
  anywhere; it's a one-time migration, not a standing handoff, and doesn't touch (1) or (3) either.

**Decision.**
- **Phase 1 (done here):** fix (1) directly — the Sessions window can now open the Browser window with
  one click (`QuickView`'s new "Browser" button, `bridge.openWindow("browser")`), on the same shared
  `persist:browser` profile every browser task already uses. This also covers the literal ask ("any
  session in the Sessions window can open a browser... with the same logged-in state"): there is one
  shared browser and one shared profile, so opening it is attaching to it.
- **Phase 2 (recommended, not built):** Option C for the "take over what I'm doing in real Chrome" case,
  plus Matthew logging into the sites he cares about once, by hand, in the Browser window (Option A) —
  that alone should fix most of friction (2), since the blocker was never *where* to log in, it was that
  no one had.
- **Rejected for now:** B (standing CDP port) outright; D as anything more than a possible one-time
  bootstrap if Option C's one-at-a-time hand-off proves too slow for Matthew in practice.

**Open questions for Matthew, before Phase 2 starts:**
1. OK with a Chrome extension (loaded unpacked in dev, or published unlisted) that can attach DevTools
   to a tab on command, and a local JARVIS↔extension connection? That's the part with real reach into
   his everyday browser.
2. "Take over" from the corner-menu button or from a spoken/typed "take over": does the task running in
   the Browser window move into the real-Chrome tab, or does the real-Chrome tab's state (URL, and
   whatever JARVIS can read of the page) get handed to a fresh tab in the Browser window instead? The
   second is simpler and safer (no standing `chrome.debugger` session once the handoff is done) but
   loses in-page state (an open modal, a part-filled multi-step form).
3. Does "JARVIS continues the task in that same logged-in context" mean the rest of the task should run
   in his real Chrome tab (visible, with Chrome's debugging banner up), or only that one handoff step,
   with JARVIS then working in the Browser window as usual?

**Consequences.** Until Phase 2, cross-site sign-in is still one Matthew does by hand in the Browser
window — Phase 1 just makes it easier to get there. No new tool, origin or wire format: `browser_task`'s
origin set stays `telegram | desk-voice | desk-typed | dashboard | browser`; a cloud session (what the
Sessions window shows, JD-32) still can't start or drive a browser task itself, only open the window to
watch or use it directly — doing that remotely would need a new authenticated path for a cloud session
to call `BrowserTaskRunner.start`, which is its own security decision and is out of scope here.
