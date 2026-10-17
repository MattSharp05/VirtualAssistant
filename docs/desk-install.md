# Installing JARVIS Desk

JARVIS Desk is a normal Mac app you download. It isn't on the App Store and isn't registered with
Apple, so macOS asks you once to confirm you want to open it.

## 1. Download
1. Open the repo's **Releases** page: https://github.com/MattSharp05/VirtualAssistant/releases
2. Under the newest **JARVIS Desk** release, download `JARVIS-Desk-<version>-arm64.dmg`
   (Apple Silicon Macs).

## 2. Install
1. Double-click the `.dmg`. A window opens with the JARVIS Desk app.
2. Drag **JARVIS Desk** into **Applications**. (It must live in Applications: macOS remembers its
   permissions for that location.)
3. Eject the disk image.

## 3. Open it the first time
1. Open **Applications** and double-click **JARVIS Desk**. macOS says "JARVIS Desk Not Opened"
   (Apple could not verify it). Click **Done**.
2. Open **System Settings → Privacy & Security**, scroll down to **Security**, and next to
   "JARVIS Desk was blocked to protect your Mac" click **Open Anyway**. Confirm with your password
   or Touch ID, then click **Open Anyway** once more.
   You only do this once; after that it opens normally.

(On macOS 15 and later, right-click → Open no longer skips this check; older guides that say so
are out of date.)

Faster, from Terminal: `xattr -dr com.apple.quarantine "/Applications/JARVIS Desk.app"`, then open
it normally. This also fixes "is damaged and can't be opened".

## 4. Permissions it asks for, and why
macOS asks the first time each one is needed. You can change them later in **System Settings →
Privacy & Security**.

| Permission | Why | When it's asked |
|---|---|---|
| **Microphone** | To hear you after "Jarvis" or the ⌥⌥ push-to-talk key. Nothing is recorded or sent before that. | First time you talk to it |
| **Input Monitoring** | To notice the ⌥⌥ (right Option, double-tap) key from any app. It only looks at that key. | First time push-to-talk starts |
| **Camera** | Only when **Camera hands** is on, to track your hands. | When you switch Camera hands on |
| **Screen Recording** | Only when you ask "what am I looking at?". | The first time you ask |

## 5. Pair it with JARVIS
1. On the JARVIS dashboard, find **Desk devices** → **Pair a Mac**, give it a name and copy the key
   (shown once).
2. In JARVIS Desk, Settings opens on first launch: paste your JARVIS address
   (`https://jarvis.<your-tailnet>.ts.net:8443`) and the key, then **Test connection**.

## Quitting
JARVIS Desk has an icon in the **Dock** (and in ⌘Tab) as well as the menu bar. Any of these quits it:
- **Dock:** right-click the JARVIS Desk icon → **Quit**.
- **⌘Q** while any JARVIS Desk window is in front (or **JARVIS Desk → Quit JARVIS Desk** in the menu bar).
- **Menu bar icon** (the small orb, top right) → **Quit JARVIS Desk**.
- **Command bar:** ⌘⇧Space, type `quit`, press ↵.
- **Orb:** right-click (or control-click) the orb → **Quit JARVIS Desk**.
- **Settings:** the **Quit JARVIS Desk** button at the bottom.

Prefer a menu-bar-only app? Switch off **Settings → Faces & status files → Show in Dock**; the Dock
icon goes at once (switch it back on the same way).

If none of those are reachable, quit it from Terminal:

```sh
osascript -e 'quit app "JARVIS Desk"'
```

## Updating
When a new version is out, JARVIS Desk offers it: click **Download & install**, then drag the new
app over the old one in Applications. (Installing quits JARVIS Desk first.)

Updating by hand: quit JARVIS Desk (above), drag the new app from the `.dmg` into Applications and
choose **Replace**, then open it again. Finder refuses to replace the app while it's still running.
