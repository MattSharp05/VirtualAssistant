# 0011 — QA through a web preview with scenarios, plus a .dmg per PR
**Context.** QA in Notion needs links; most of the Desk is UI.
**Decision.** The renderer also builds as a static web app with a mock `window.desk` bridge driven by deterministic scenarios (`?scenario=&window=`), deployed to Vercel per PR (production = main). Native behaviour (overlay, audio, hotkeys, camera) is QA'd with the PR's `.dmg` artifact, and smoke-tested in CI with Playwright `_electron` on macOS.
**Consequences.** Every window must render from the mock bridge; scenarios are part of each window ticket's definition of done.
