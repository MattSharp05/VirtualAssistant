# Technical Design — JARVIS Desk
Status: Approved (2026-10-14) · PRD: https://app.notion.com/p/3f924983f3ca810daa8ac980d7d4fab7 · Mockups: https://claude.ai/artifact/CdmCZuqgXrtboVyw2MbcR4

Two halves that ship together:
- **JARVIS server** (exists, `src/`): Node 22 + TypeScript in Docker. Gains a streaming brain, memory, tasks, a Desk API and background jobs.
- **JARVIS Desk** (new, `desk/`): an Electron app on Matthew's Mac. Overlay orb, voice, windows. It is a client of the server and keeps no assistant logic of its own.

## Stack
| Piece | Choice | Why |
|---|---|---|
| Server | Node 22, TypeScript, `node:test` (as today) | No rewrite; 38 tests already guard it |
| Brain | `claude -p` kept running with `--input-format stream-json --output-format stream-json` | Subscription billing, ~1–2 s to first token on warm turns (ADR 0003) |
| Desk shell | Electron (latest stable), TypeScript | Transparent click-through always-on-top windows on macOS; same language as the server (ADR 0001) |
| Desk UI | React 18 + Vite, plain CSS per feature, zustand for state | Many windows, one renderer bundle; CSS files per feature avoid merge collisions |
| Desk ↔ server | REST + Server-Sent Events, bearer device key, over Tailscale | Simple, works through Tailscale Serve, one-way push is all we need (ADR 0002) |
| Wake word | Picovoice Porcupine (built-in "jarvis") via `@picovoice/porcupine-node` + `@picovoice/pvrecorder-node` | On-device, exact keyword, free personal key (ADR 0004) |
| Push-to-talk key | `uiohook-napi` global key hook (double-tap right ⌥) | Electron's globalShortcut can't bind a bare modifier (ADR 0004) |
| Endpointing | Silero VAD (onnxruntime-node) | Ends the utterance on silence; robust to fans/keyboards |
| Speech to text (Mac) | whisper.cpp (`base.en`, Metal) as a bundled binary; model downloaded on first run (~140 MB) | Offline, ~0.3 s for a short utterance on Apple Silicon |
| Speech out (Mac) | macOS `say -v <voice> -o <file>` per sentence, played in the renderer with WebAudio | Free built-in voices; WebAudio gives the waveform for the orb |
| Voice notes (container) | whisper.cpp (CPU) in, Piper TTS + ffmpeg (OGG/Opus) out | Telegram voice notes both ways without paid APIs (ADR 0005) |
| Memory + tasks | Notion API with the existing internal integration (write scoped in code) | Matthew can read and edit both (ADR 0006) |
| Calendar/Gmail/Slack | claude.ai connectors through the CLI (as today); calendar writes now allowed | No OAuth app of our own (ADR 0008) |
| Hand tracking | MediaPipe Tasks Vision HandLandmarker (WASM) in the overlay renderer | Same building block as barehands; our own gestures (ADR 0012) |
| Packaging | electron-builder → unsigned arm64 `.dmg` on GitHub Releases; own lightweight updater | No Apple developer account; Squirrel auto-update needs signing (ADR 0010) |
| QA preview | Vite web build of the renderer with a mock bridge + scenarios, deployed to Vercel per PR | Clickable links in the Notion QA block (ADR 0011) |

## Architecture
```
 Mac ─────────────────────────────────────────────┐        Container (Docker now, VPS later)
 JARVIS Desk (Electron)                            │        ┌──────────────────────────────────────┐
  main process                                     │        │ HTTP :8080 (dashboard + /api/desk/*) │
   · windows: overlay, app windows, ambient        │  REST  │  · DeskApi: auth, SSE /events, REST  │
   · tray menu, shortcuts, uiohook (⌥⌥)           │◄──────►│ Brain (warm claude -p, streaming)    │
   · audio: pvrecorder → Porcupine / VAD / whisper │  SSE   │  · MCP tool server (mcp.ts)          │
   · `say` TTS, uploads, folder RPC, screenshots   │        │  · claude.ai connectors (Cal/Gmail/   │
  renderer (React, one bundle, route per window)   │        │    Slack), Notion API (memory/tasks)  │
   · orb, cards, launcher, command bar, windows    │        │ Worker brain (digest, suggestions)   │
   · MediaPipe hands (overlay only)                │        │ Scheduler (timers, reminders, jobs)  │
 └─────────────────────────────────────────────────┘        │ Telegram bot (+ voice notes)         │
                                                             │ Store (JSON in /data)                │
                                                             └──────────────────────────────────────┘
```
- **One brain conversation** is shared by Telegram, dashboard and Desk (as today). The **worker brain** is a separate conversation used only by background jobs (Today digest, calendar range fetch, task suggestions), so jobs never pollute the chat.
- **Events** (orb state, reply deltas, tool steps, cards, notifications, task/digest updates) are published on an in-process event bus and fanned out to SSE clients (Desk) and Telegram where relevant.
- **The Desk renderer never talks to the server directly.** It calls `window.desk.*` (preload bridge); main does HTTP/SSE. In the web preview the same bridge is a mock fed by scenarios.

## Project structure
```
src/                 server (existing) — new modules below
  brain/             warm process, stream parser, worker brain
  desk/              DeskApi: auth (device keys), SSE hub, REST routes
  memory.ts tasks.ts calendarLog.ts scheduler.ts notify.ts digest.ts suggest.ts uploads.ts voice/
shared/              protocol.ts — Desk API types + event union (imported by server and desk)
desk/                Electron app (npm workspace)
  main/              index.ts, windows/, audio/, voice/, tray.ts, updater.ts, bridge.ts, rpc.ts
  preload/           exposes window.desk
  renderer/          React app: app/ (router, theme), features/<window>/ (component + css), orb/, hands/
  renderer/mock/     mock bridge + scenarios (web preview + e2e)
  e2e/               Playwright: web build specs, electron smoke
docs/TDD.md, docs/decisions/
```
Every window is a folder under `desk/renderer/features/` with its own CSS, a `feature.ts` (id, title, icon, min/default size; plain data the main process also reads) and an `index.tsx` (the component). `features/registry.ts` discovers them by glob, so tickets adding windows don't collide. Main's window manager (`desk/main/windows/manager.ts`) opens each in a frameless vibrancy window with the shared glass frame (`app/WindowFrame.tsx`) and remembers its bounds.

## Data & state
- **Server store** (`/data/jarvis/state.json`, existing): adds `devices` (hashed keys), `calendarLog`, `timers`, `digest` cache, `suggestionSeen` (dedupe keys), brain session ids (chat + worker).
- **Notion:** `JARVIS Memory` page (bulleted facts; the whole page is injected at conversation start), `JARVIS Tasks` database: Name, Status (Suggested / Open / Done / Dismissed), Due, Project, Priority, Source (You / Slack / Email / Session / Notion QA), Source link, Dedupe key. Created by `npm run setup:notion` under a page shared with the integration.
- **Desk** (`~/Library/Application Support/JARVIS Desk/`): settings.json (server URL, voice, hotkeys, wake sensitivity, folders, layouts, window bounds), device key encrypted with Electron `safeStorage` (Keychain), downloaded models (whisper, Silero), web-view sessions (`persist:web` partition for claude.ai/notion.so).
- **Secrets:** the server keeps its secrets in `.env` as today (no new ones). The Picovoice key and the device key live on the Mac only (Settings, Keychain). Nothing secret is bundled in the app.

## Desk API (summary; full types in `shared/protocol.ts`)
- `POST /api/desk/pair` (dashboard-authenticated) → one-time device key; `GET /api/desk/events` (SSE); `POST /api/desk/chat` (streams deltas over SSE, returns message id); `GET /api/desk/today|calendar?range=|tasks|sessions|session/:id|notion/search|notion/page/:id|system`; `POST /api/desk/tasks/:id/(accept|dismiss|done)`, `/files` (upload), `/rpc/:id` (answers to server→Mac requests: folder read, clipboard, screenshot).
- Auth: `Authorization: Bearer <device key>`; keys stored hashed; revocable from the dashboard.

## Scenario system
- `desk/renderer/mock/scenarios/*.ts`: each exports a named, deterministic state (sessions, digest, tasks, chat history, orb state, events to replay with timings).
- Web preview: `?scenario=<name>&window=<chat|sessions|…|overlay>`; `/dev.html` lists every scenario × window as links. Same names drive Playwright specs.
- Electron app: `JARVIS_DESK_SCENARIO=<name>` starts it against the mock bridge (used by the macOS smoke test). Never active in a release build unless that env var is set.

## Testing strategy
- **Server unit** (`node:test`, as today): fake `claude` binary emitting stream-json, fake fetch for Notion, fake Telegram. New: stream parser, event bus, DeskApi auth/SSE, scheduler with fake clock, suggestion dedupe, calendar change log.
- **Desk unit** (Vitest): gesture maths, VAD/endpointing state machine, double-tap detector, sentence splitter, window layout maths, reducers.
- **Desk e2e** (Playwright, Chromium) against the web build + scenarios: one desktop project. Visual snapshots of each window (CI only, 0.2% tolerance).
- **Electron smoke** (Playwright `_electron`, macOS runner): launch with a scenario, assert overlay + a window render, screenshot artifacts.
- **Manual (QA block):** overlay feel, click-through, Spaces/full-screen, mic/wake word/voice quality, latency, camera hands.
- **Perf:** a latency probe logs speech-end → first audio; budget ≤ 2.5 s (warm, simple question). Idle CPU/RAM sampled in the smoke test. JD-48: `desk/main/latency.ts` times every voice turn (endpoint, transcript, sent, accepted, first delta, first sentence, say ready, first audio) into `userData/voice-latency.jsonl` and `POST /api/desk/system/latency`; the System window shows p50/p90 of the last 20 and a waterfall. Knobs in settings.json: `endpointSilenceMs`, `whisperThreads`, `whisperBeamSize`, `voiceModel` (sent as the voice turn's `model`). `POST /api/desk/chat/warm` starts the warm brain as listening begins; `say` is prewarmed then too. `desk/main/voice/pipeline.test.ts` is the synthetic benchmark on fakes.
- **CI pipeline** (two levels, PR jobs ≤ 5 min each):
  - PR gate, in parallel: server typecheck + unit; desk lint + typecheck + unit; desk e2e on web build (sharded ×2); Vercel preview (Vercel's Git integration).
  - "What changed" job adds: macOS `.dmg` build + Electron smoke when `desk/main|preload|package` change; visual snapshots when renderer CSS/components change.
  - Main: everything, including visual and the macOS build; the `.dmg` from main is the nightly.
  - Cloud sessions install with `ELECTRON_SKIP_BINARY_DOWNLOAD=1` (GitHub release downloads are blocked there); Electron only runs in CI on macOS.

## Environments & deploy
- **Local server:** `docker compose up -d --build` (as today). Production server = Matthew's container; QA server changes there.
- **PR previews:** Vercel project for `desk/renderer` web build (preview per PR, production = main). `.dmg` per PR as a workflow artifact when desk native code changed.
- **Releases:** tag `desk-v*` → GitHub Release with `JARVIS-Desk-<ver>-arm64.dmg`. The app checks the latest release on launch and daily.

## Conventions
- Conventional commits with ticket IDs; one ticket → one PR (dev-workflow).
- `shared/protocol.ts` is the only place Desk/server types live; changing it requires updating both sides in the same PR.
- Renderer features are self-contained folders; no feature imports another feature's internals (use `app/` or `shared/`).
- Never log tokens, device keys, transcripts of other people's messages beyond what's shown to Matthew.

## Risks & open questions
- **Unsigned app:** macOS asks once (right-click → Open); permissions (Microphone, Camera, Input Monitoring for ⌥⌥, Screen Recording for screen awareness) are granted per app path, so the app must live in /Applications. Updates replace it in place.
- **Warm CLI process:** undocumented stream-json input details may change; fallback is today's one-process-per-message path behind a flag.
- **Connector-driven windows** (Today, Calendar) cost plan usage per refresh and are only as fresh as the last job (30 min, or on open).
- **Calendar undo** relies on the brain fetching the event before changing it; the change log records what it saw. Deletes stay recoverable from Google's Bin for 30 days.
- **Embedded claude.ai / notion.so** may block sign-in methods inside an app (Google SSO); email sign-in works.
- **Picovoice free tier** requires an online key check periodically and is limited to personal use.
