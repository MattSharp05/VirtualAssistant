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
- Vision mockup: https://claude.ai/artifact/CdmCZuqgXrtboVyw2MbcR4
- Preview URLs: batched QA mode. Desk UI browser preview + scenario links per PR (set up in the first epic), plus a .dmg per PR from a macOS runner. Server changes are QA'd on the running container after `git pull && docker compose up -d --build`. Production: Matthew's own Mac + container.
- QA mode: batched (batch ends at checkpoints: overlay + orb + first window; voice loop; camera hands)
- Merge policy: fast — merge now; main's full suite checks the combination and a red main is reverted.

## Stack
_To fill after the TDD (/plan-work)._ Server: Node 22 + TypeScript, `node:test`, Docker. Desk: Electron (planned).

## Commands
- `npm test` — typecheck + unit tests (fake claude binary, no network)
- `npm run build` — compile to `dist/`
- `docker compose up -d --build` — run the server locally

## Structure
_To fill after the TDD._

## Conventions
_To fill after the TDD._ Never print or open `.env` or tokens; secrets go in `.env` only.

## Testing
_To fill after the TDD._
