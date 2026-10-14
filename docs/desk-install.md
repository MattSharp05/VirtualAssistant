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
1. Open **Applications**, **right-click** JARVIS Desk and choose **Open**.
2. macOS says it can't check the developer. Click **Open** again.
   You only do this once; after that it opens normally.

If macOS refuses with "is damaged and can't be opened", open Terminal and run:
`xattr -dr com.apple.quarantine "/Applications/JARVIS Desk.app"`, then open it again.

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

## Updating
When a new version is out, JARVIS Desk offers it: click **Download & install**, then drag the new
app over the old one in Applications.
