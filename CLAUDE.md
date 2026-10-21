# JARVIS

JARVIS is Matthew's personal assistant. The server (this repo's `src/`) runs headless in Docker on the
Claude subscription: it drives Claude Code cloud sessions, chats through `claude -p` with its own tools
(sessions, Notion, Google Calendar, Gmail, Slack), and is reachable from Telegram and a dashboard.
**JARVIS Desk** (in progress) adds a macOS overlay app: an orb that listens and speaks, and windows for
chat, sessions, today, calendar, to-dos and Notion. PRD and tickets are in Notion (below).

## Workflow
Follows the `dev-workflow` skill (ticket-driven: Notion → branch → PR → QA → merge).
- Notion project page: https://app.notion.com/p/3f924983f3ca810daa8ac980d7d4fab7
- Tickets data source: collection://97df4bde-6ac0-42d6-a1cc-0b0838864dfb   (ID prefix: JD)
- Epics data source: collection://4bf55450-4057-4860-acb8-82e4ea365cb7
- GitHub: MattSharp05/VirtualAssistant
- Project slug: jarvis
- Vision mockup: https://claude.ai/artifact/CdmCZuqgXrtboVyw2MbcR4
- Preview URLs: batched QA mode. Desk UI browser preview + scenario links per PR (set up in the first epic), plus a .dmg per PR from a macOS runner. Server changes are QA'd on the running container after `git pull && docker compose up -d --build`. Production: Matthew's own Mac + container.
- QA mode: batched (batch ends at checkpoints: overlay + orb + first window; voice loop; camera hands)
- Merge policy: fast — merge now; main's full suite checks the combination and a red main is reverted.

## Stack
Full design: `docs/TDD.md` + ADRs in `docs/decisions/`.
- **Server** (`src/`): Node 22 + TypeScript, `node:test`, Docker. Brain = a warm `claude -p` stream-json process (ADR 0003); tools via the stdio MCP server `src/mcp.ts`; claude.ai connectors for Calendar/Gmail/Slack; Notion API for memory + tasks.
- **Desk** (`desk/`, npm workspace): Electron + React 18 + Vite + zustand, Vitest, Playwright. Voice: PvRecorder + Porcupine, uiohook-napi (⌥⌥), Silero VAD, whisper.cpp, macOS `say`. Hands: MediaPipe HandLandmarker.
- **Shared** (`shared/protocol.ts`): Desk API types + event union, the only place they live.

## Commands
- `npm test` — server typecheck + unit tests (fake claude binary, no network)
- `npm run build` — compile the server to `dist/`
- `docker compose up -d --build` — run the server locally
- `npm -w desk run e2e` — Playwright on the web build (in a cloud session add `PW_CHROMIUM_PATH=/opt/pw-browsers/chromium`); `VISUAL=1` adds snapshots, whose baselines come from the `mcr.microsoft.com/playwright:v1.64.1-noble` image (`--update-snapshots` inside it)
- Desk commands are added by JD Foundations tickets (`npm -w desk run …`); in cloud sessions install with `ELECTRON_SKIP_BINARY_DOWNLOAD=1` (GitHub release downloads are blocked there; Electron runs only on CI's macOS runner).

## Structure
- `src/` server · `src/brain/` warm brain + worker · `src/desk/` Desk API (auth, SSE, REST)
- `shared/` protocol types used by both sides
- `desk/main` Electron main · `desk/preload` bridge · `desk/renderer` React (`features/<window>/` each with its own CSS, `feature.ts` metadata and `index.tsx` component; `mock/scenarios/` for preview and e2e) · `desk/e2e`
- `docs/TDD.md`, `docs/decisions/`

## Conventions
- One ticket → one branch → one PR; conventional commits with the ticket ID.
- Renderer features are self-contained folders (`feature.ts` + `index.tsx`), discovered by glob in `features/registry.ts` (never edit it to add one); windows render in `app/WindowFrame.tsx`; no cross-feature imports.
- Changing `shared/protocol.ts` updates both server and desk in the same PR.
- Never print or open `.env` or tokens; secrets go in `.env` (server) or the Keychain (Mac). Notion writes only to the JARVIS Memory page and JARVIS Tasks database.
- **JARVIS tool access:** every window/feature ships with the JARVIS tool(s) it needs (read/add/update, as sensible) plus a test for them, or the ticket has an explicit "N/A because…". JARVIS (Telegram/Desk chat) must be able to do by voice or text whatever its window does — e.g. the Ideas window shipped with `add_idea` (`src/tools/ideas.ts`).
- **Session naming:** every session JARVIS starts (`start_session` or the routine) is titled `J<job number> · <Project> - <summary> (<role>)`, e.g. `J17 · JARVIS Desk - adding session naming rule (orchestrator)` — role is `orchestrator`/`builder`/`design`/`scoping` (`src/sessionTitle.ts` `deriveTitleRole`). This is the session's real title in Claude, not just JARVIS's own record of it: set at creation when the sessions API allows it, or right after for routine-fallback sessions (the routines-fire API can't set one); `rename_jarvis_sessions` retries any that didn't take and re-titles old "Jarvis Worker" sessions the same way.

## Testing
- Server: `node:test` with fakes (claude stream-json binary, fetch, Telegram, clock).
- Desk: Vitest for logic; Playwright e2e on the web build with `?scenario=&window=`; Electron smoke on macOS CI. Every window renders from the mock bridge; new states get a scenario.
- CI: fast PR gate (jobs ≤ 5 min) + full suite on main; macOS `.dmg` build when native desk code changes.
- Definition of Done: the `dev-workflow` skill.
