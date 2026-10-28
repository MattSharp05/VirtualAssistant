# JARVIS friction log — options and recommendations

Source: Matthew's "why I'm not using it more" list (also saved in the JARVIS Ideas window). This
doc proposes concrete options, trade-offs and a recommendation for each point, and notes what's
already shipped from this pass. It's a planning doc, not an ADR — promote a decided option to
`docs/decisions/` when it's picked.

## 1. Not always accessible (Docker on the Mac → always-on)

The architecture already anticipated this: `docker-compose.yml` comments say the Tailscale sidecar
"gives JARVIS a permanent … address, on a laptop or a VPS alike", and `docs/TDD.md`'s own diagram
labels the container "Docker now, VPS later". So this is an ops move, not a rewrite.

**Options**
- **A. Small VPS, same `docker compose up -d --build`.** Hetzner CX22 (~€4–5/mo) or a DigitalOcean
  $6/mo droplet. Copy `.env` and the `jarvis-data` volume over, run `claude auth login` once on the
  box, keep the same Tailscale hostname (or update Desk's `serverUrl` if it changes). Lowest
  mental overhead: identical stack, same images, same compose file.
- **B. Managed platform (Fly.io / Railway).** Similar cost, less OS upkeep (no SSH hardening,
  patching), but another platform's quirks to learn, and the warm `claude -p` process plus
  `/data` volume both need to survive restarts/sleeps, which these platforms don't always guarantee
  on their cheapest tier.
- **C. Keep the Mac, make it durable** (`caffeinate`, launchd keepalive, auto-reboot recovery).
  Zero migration, but doesn't fix "my laptop is closed/asleep/travelling" — the actual complaint.
- **D. A home box (Mac mini / NUC) as a dedicated always-on server.** Same as A operationally, no
  recurring fee, but needs a machine Matthew is willing to leave on permanently.

**Recommendation:** A. It's the smallest change from what's already running, costs very little, and
the compose file was written with exactly this move in mind. I wrote `docs/deploy-vps.md` with the
concrete steps (provisioning, data migration, the one open question: Claude subscription auth is tied
to `claude auth login` inside the container, not an API key — that session needs re-establishing on
the new box, which only Matthew can do since it's his subscription).

**Open question for Matthew:** pick a provider (Hetzner vs DigitalOcean vs your own hardware) and I'll
walk the runbook with you, or do the provisioning if you hand me SSH access to a fresh box.

## 2. One endless conversation (no project/topic threads)

`src/brain/index.ts` is explicit: "One conversation at a time, resumed across messages; 'new
conversation' starts a fresh one." There's a manual reset, but no persistent multiple threads to
switch between — Matthew said himself the best solution is unclear, so this is genuinely open.

**Options**
- **A. Explicit named threads** (`/new <topic>`, `/switch <topic>`), each with its own `claude -p`
  session resumed independently; Telegram and Desk both get a thread picker. Most control, but
  Matthew has to remember to create/switch threads — exactly the overhead that makes "just keep
  talking" appealing today.
- **B. Auto-detected project threads.** The brain already tags sessions by ticket prefix per project
  (`PROJECTS` in `src/config.ts`); reuse that: when a message clearly names a project ("the Trip
  app", "JARVIS Desk"), route it to that project's thread automatically, falling back to a general
  thread. Low effort from Matthew, but misclassification is annoying in a chat he can't easily
  correct from his phone.
- **C. Keep one conversation, add structure inside it** — a `/summary` or pinned context block per
  project the brain re-reads, no thread-switching at all. Doesn't solve "I have to scroll past
  unrelated stuff", but is the smallest change and fits how Telegram already works (one chat).
- **D. Hybrid:** B's auto-routing, with Desk's Chat window showing a thread list (so switching is a
  click, not a command) and Telegram defaulting to "whichever thread I last used" unless a project is
  named.

**Recommendation:** D, built incrementally — start with B's auto-routing (cheap, reuses `PROJECTS`)
and land the Desk thread list once that's proven useful. This is a multi-ticket feature (shared
protocol changes, brain session management, two UIs), not a single clear fix — flag it as a JD epic
rather than something to patch in this pass.

**Open question:** when JARVIS can't tell which project a message is about, should it ask, or default
to the last-used thread?

## 3. Features aren't integrated (browser login)

Checked `desk/main/browser/host.ts` and `policy.ts`: the Browser window already runs on its own
**persistent** profile (`persist:browser` — "the profile keeps the sign-ins" per the file's own
comment), separate on purpose from the embedded claude.ai/Notion views' `persist:web` partition
(JD-39, kept separate for isolation). So once Matthew logs into a site inside the JARVIS Browser
window, it should stay logged in there — the friction is likely one of:
- the login never happened in *that* profile (Matthew's regular Chrome has the session, JARVIS's
  browser doesn't, and there's no way to hand one to the other); or
- the site actively resists the automated profile (Instagram and others fingerprint/challenge
  Chrome-DevTools-Protocol-driven browsers, which `host.ts`'s agent is).

**Options**
- **A. "Hand a login to JARVIS":** a Settings action that exports the relevant cookies from Matthew's
  real Chrome (via a short, explicit, user-initiated flow — never silently) into `persist:browser`.
  Fixes the "I'm already logged in elsewhere" case directly; doesn't help sites that fingerprint CDP
  regardless of cookies.
  **Security note:** this is session-hijacking-shaped even when self-initiated, so it has to be an
  explicit opt-in action with a clear UI, cookies scoped to the one site, and never silent or
  automatic.
- **B. Do nothing special for hostile sites; document "log in once in the JARVIS Browser window"** as
  normal onboarding per site (it already persists after that). Zero code, but doesn't help Instagram-
  style challenge flows, which may legitimately block most automation regardless of what JARVIS does.
- **C. "Take over" in the other direction** (already partly built — the Browser window's Toolbar has
  Take over/Hand back): make it bidirectional so Matthew can start in his own browser, then say
  "JARVIS, take this over" and have the *page's current state* (not just a fresh load of the same
  URL) handed to the JARVIS Browser window. Technically harder (session/local-storage transfer across
  browser engines, or literally remote-controlling Matthew's real Chrome via something like the
  Chrome extension approach other Claude surfaces already use) and the biggest trust/security surface
  of all the options here.
- **D. Point the Browser window at Chrome via the same automation approach "Claude in Chrome" uses**
  instead of a separate Electron-embedded profile, so it's Matthew's actual logged-in browser from the
  start. Removes the separate-profile problem entirely, at the cost of the sandboxing `policy.ts`
  explicitly chose (separate partition, no file-chooser dialogs, controlled downloads).

**Recommendation:** B first (cheapest — confirm persistence is actually the issue by deliberately
logging into Instagram once in the JARVIS Browser window and seeing if it survives a restart), then A
if cookie-copying is still wanted for specific stubborn sites. C/D are both bigger security-sensitive
redesigns that deserve their own ticket and a explicit decision from Matthew, not a quick patch.

**Open question:** next time Instagram is the blocker, what exactly happens — a CAPTCHA, a "suspicious
login" email, or a flat refusal? That changes which option is worth building.

## 4. Corner menu (fan-out) — ✅ shipped this pass

Two real gaps, both fixed in this branch:
- **Browser was missing from the ring.** `ringLayout.ts`'s `RING` list is hand-maintained (by
  design, per its own comment) and simply never had a `browser` entry. Added it, between Agents and
  Today. Updated the tests and e2e spec that hardcoded "nine buttons" to ten; the Playwright visual
  baseline for `launcher-open` will need `--update-snapshots` run in the pinned Playwright image
  during QA (I can't run that image from this sandbox — no Docker daemon here).
- **The shortcut clash.** `⌘⇧Space` was hardcoded in three places (`commandbar.ts`, `index.ts`,
  `trayMenu.ts`) with no way to change it short of editing source. Added a `commandBarShortcut`
  setting (JD-83) — five safe presets in Settings → Hotkeys (⌘⇧Space, ⌘⌥Space, ⌃⇧Space, ⌘⇧J, ⌘⌥J) —
  so picking a non-clashing shortcut is now a dropdown, not a rebuild.

Settings → Hotkeys → "Command bar" now has that dropdown; pick whichever doesn't fight your other
app.

## 5. Voice and camera

I can't reproduce this from here — it needs a few answers only Matthew's own Mac can give. What I
confirmed in the code: wake word needs a Picovoice AccessKey (Settings → Wake word), the hook needs
Microphone + Input Monitoring + Accessibility permissions (there's already a self-healing permission
card for the Input Monitoring/Accessibility path, `desk/main/permissions.ts`), and whisper's model
(~140 MB) downloads on first run. Camera hands needs Camera permission and is off by default
(`cameraHands` setting) because of its ~10–15% CPU cost.

**Diagnostic options, cheapest first**
- **A. Check what's already there:** Settings → Wake word — is an AccessKey entered? Settings →
  Hotkeys — which push-to-talk mode, and does pressing it do anything? The menu-bar tray's "Talk to
  JARVIS" item status line (shows `no-key`/`bad-key`/`paused`/`listening`/`error`) — what does it say
  right now?
- **B. Surface that status more visibly.** Today the wake-word status line only shows in the tray
  menu dropdown — easy to never notice. A quick win: show the same line directly in Settings → Wake
  word, next to the AccessKey field, so "why isn't this working" has an answer right where you'd look
  for it. I'd scope this as a small follow-up ticket rather than guessing at the exact wording without
  seeing your current tray line.
- **C. A "Voice check" button** in Settings that runs through mic permission → AccessKey validity →
  model-downloaded → a one-word test transcription, reporting which step failed. More build, but turns
  "I don't know why" into a direct answer.

**Recommendation:** B as a quick, low-risk visibility fix once I know what your tray currently shows;
C if B isn't enough.

**Open questions:** (1) What does the tray's "Talk to JARVIS" line say right now — any status text
under it? (2) Has a Picovoice AccessKey ever been entered in Settings → Wake word? (3) When you've
tried the push-to-talk key, does the orb change at all? Answers to these tell me whether this is a
missing key, a missing permission, or something else entirely — hand-tracking's camera permission is
a separate, simpler check (System Settings → Privacy → Camera → JARVIS Desk).

## 6. Starting new environments/sessions

This already has more plumbing than the friction log suggests: `PROJECTS` (`src/config.ts`, JD-85)
lets each project declare its own repo, cloud `environment` (env_…), model, merge policy and extra
build instructions — e.g. the `drift` example already in `.env.example` has its own environment and
a `Run npm run verify before opening a PR` instruction. Sessions on a project not yet listed fall back
to `SESSION_ENVIRONMENT_ID`, the one default environment.

So the real question isn't "one environment for everything or one per project" as an either/or — the
code already supports per-project environments, and a shared default for anything unregistered. The
Trip friction was most likely either (a) Trip wasn't in `PROJECTS` yet, so JARVIS had nowhere good to
run it and fell back to the slow path of creating an environment on the spot, or (b) creating a brand
new cloud environment for a repo that's never run one before is inherently slow the first time
(dependency install, setup scripts) — a platform cost, not something JARVIS's own code controls.

**Options**
- **A. Make "register a project" a standing first step.** Whenever Matthew starts something new,
  add it to `PROJECTS` immediately (repo, environment if it needs one) rather than discovering the gap
  mid-task. Zero new code — just a habit/checklist, and I can do the `PROJECTS` edit for him on
  request.
- **B. A standing "scratch" environment** for anything not yet registered, so there's never a cold
  "create an environment from nothing" moment — new/one-off repos get a working (if generic) sandbox
  immediately, and graduate to their own `PROJECTS` entry once they're a real ongoing project.
- **C. Pre-warm environments.** If the cloud sessions API supports creating/priming an environment
  ahead of time, JARVIS could do that as soon as a new repo is mentioned, during idle time, so it's
  ready before Matthew asks. Needs checking what the sessions API actually exposes — I'd scope this
  as a research spike before committing to it.

**Recommendation:** A now (cheap, fixes the specific Trip-shaped gap), B as the standing fallback so
a forgotten registration never costs a slow cold start again.

**Open question:** should I go ahead and add Trip to `PROJECTS` now? I'd need its repo URL (and
whether it already has a cloud environment, or needs one created).

## 7. Agents/workflow view

The Agents window (JD-58, `desk/renderer/features/agents/`) already exists and is a real feature —
a pannable, zoomable tree of **projects → orchestrators → builders**, built live from whatever
sessions exist (`model.ts`'s `buildTree`). It's in the launcher ring already, under "Agents". So this
isn't a missing feature so much as an unused one, and what Matthew's describing — fixed role boxes
(orchestrator, two builders, two testers, one reviewer) that sessions *fill* rather than a tree that's
just whatever's currently running — is a different, more structured idea: a **workflow template**.

**Options**
- **A. Nothing new — just use what exists.** The current tree already shows every orchestrator and
  its builders live; if the only gap is "I didn't know this was here", the fix is discoverability
  (it's one launcher click away) rather than a new feature.
- **B. A per-project template layer on top of the existing tree.** Each project in `PROJECTS` gets an
  optional `roles` list (e.g. `["orchestrator", "builder", "builder", "tester", "tester", "reviewer"]`);
  the Agents window renders those as fixed, always-visible boxes, and live sessions slot into the
  matching box by role instead of appearing as free-floating tree nodes. Needs a way for a session to
  *declare* its role (a tag the orchestrator sets when it spawns a builder/tester), a new field in
  `shared/protocol.ts`'s `AgentsResponse`, and real design thought about what happens with more
  sessions than boxes, or a role with none running.
- **C. A separate, purely illustrative "workflow diagram" per project** (static, hand-authored, not
  wired to live data) just to show the intended shape of a project's agent team. Much less work than
  B, but doesn't solve "sessions appearing in the boxes when needed" — the part Matthew actually
  asked for.

**Recommendation:** A first — worth confirming the existing window covers this before building
anything. If the fixed-role-boxes idea still stands once you've tried it, B is the real feature;
it's a multi-ticket epic (protocol change + orchestrator-side role tagging + renderer work), not a
quick patch, and deserves its own design pass given how specific the "Mario Kart" example was.

**Open question:** have you opened the Agents window from the launcher since this was written? If
the live tree still doesn't match what you want, the gap is specifically "fixed boxes sessions fill",
which is option B — worth a proper ticket.
