# 0010 — Unsigned .dmg on GitHub Releases, our own updater
**Context.** No App Store, no Apple developer account. Squirrel.Mac (Electron autoUpdater/electron-updater) requires a signed app.
**Decision.** electron-builder builds an ad-hoc-signed arm64 `.dmg` on a macOS runner and attaches it to a GitHub Release (repo is public: free minutes, no token). The app checks `releases/latest` on launch and daily; if newer, a notification offers "Download & install", which downloads the dmg, opens it and quits so Matthew drags the new version over.
**Consequences.** First launch needs right-click → Open. Updates are two clicks rather than silent.
