# JARVIS

A headless personal assistant that runs in Docker and drives **Claude Code cloud sessions** from
Telegram. This is the first milestone: text JARVIS, it starts or steers a cloud session, and the
session texts you back with what it did, how long it took and how many tokens it used.

Everything runs on the Claude subscription. There's no API key and no LLM in the container: the
container is a small Node app plus the Claude Code CLI, and all the AI work happens in the cloud.

```
 You (Telegram) ──► JARVIS container ──fire routine (HTTP)────────► new cloud session
                         │            ──claude -p --cloud <id>────► existing cloud session
                         │                                               │
 You (Telegram) ◄──────── session runs scripts/report.sh (curl Telegram) ┘
```

| Action | How | Docs |
|---|---|---|
| Start a session | Routines API trigger (`POST /v1/claude_code/routines/{id}/fire`) | [routines](https://code.claude.com/docs/en/routines) |
| Message a running session | `claude -p --cloud <session-id>` in the container | [follow-ups from the CLI](https://code.claude.com/docs/en/claude-code-on-the-web#send-follow-ups-from-the-cli) |
| Hear back | The session runs `scripts/report.sh`, which posts to Telegram | [network access](https://code.claude.com/docs/en/cloud-environments) |

## Telegram commands

| Command | What it does |
|---|---|
| `/new <task>` | Starts a cloud session on the task (one routine fire) |
| `/jobs` | The sessions JARVIS started (▶ = current) |
| `/use <job>` | Picks which session plain messages go to |
| `/say <job> <msg>` | Messages a specific session |
| `/status` | Claude login, routine config, fires used this hour |
| any text | Goes to the current session |

## Setup (about 15 minutes, once)

### 1. Telegram bot
Message **@BotFather** → `/newbot` → copy the token.

### 2. Cloud environment (claude.ai/code → environment menu → new environment, e.g. "JARVIS")
- **Network access:** Custom, keep the default allowlist, and add `api.telegram.org`.
- **Environment variables:** `TELEGRAM_BOT_TOKEN=<token>` and `TELEGRAM_CHAT_ID=<your chat id>`.
  You get the chat ID in step 4. These are visible to anyone who can use the environment, which
  on a personal plan is just you.

### 3. Routine (claude.ai/code/routines → New routine)
- **Repository:** `MattSharp05/VirtualAssistant`. The routine clones the default branch, so this
  code (it needs `scripts/report.sh`) must be merged to `main` first.
- **Environment:** the one from step 2.
- **Instructions:** paste [docs/routine-prompt.md](docs/routine-prompt.md).
- **Trigger:** Add another trigger → **API** → Generate token. Copy the token (it's shown only
  once) and the routine ID (`trig_…`).

### 4. Run the container
```bash
cp .env.example .env            # fill in TELEGRAM_BOT_TOKEN, ROUTINE_ID, ROUTINE_TOKEN
docker compose build
docker compose run --rm jarvis claude auth login   # once: open the link, paste the code back
docker compose up -d
```
Send `/start` to your bot. It replies with your chat ID. Put it in `.env` as
`TELEGRAM_ALLOWED_CHAT_ID` and in the cloud environment as `TELEGRAM_CHAT_ID`, then run
`docker compose up -d` again. Until that's set the bot answers nobody but that `/start`.

Check everything: `docker compose run --rm jarvis npm run doctor`

The login and the job list live on the `jarvis-data` volume, so they survive rebuilds.
`docker compose down -v` deletes them.

### 5. The first-win test
1. `/status`: login says yes, routine configured.
2. `/new Create hello.md saying hello from JARVIS on a new branch and open a draft PR`.
   JARVIS replies with the session link. Within a few minutes the session should text you an
   acknowledgement, then the PR link.
3. Reply in plain text, e.g. `add today's date to it too`. JARVIS says "Sent to j1", and the
   session should report again.

If step 2 starts a session but you never hear back, the session can't reach Telegram: check the
environment's allowlist and variables. If step 3 fails, run `/status` and check the login.

## Metrics

| Metric | Where you see it | How it's measured |
|---|---|---|
| Time to start a session | JARVIS's reply to `/new` ("Started j1 in 1.4s") | Container: the routine API call |
| Time to deliver a follow-up | "Sent to j1 in 2.1s" | Container: the `claude -p --cloud` call |
| **Time taken per response** | Footer of every session report: `⏱ 4m12s since your message` | Session: now minus the send time JARVIS stamped on the message |
| **Tokens** | Same footer: `🔢 1.84M tokens (31k output) over 22 replies · context 85k` | Session: its own transcript, counted like claude-workflow's `session_tokens.py` |
| Routine fires used | `/status` ("Routine fires this hour: 3/30") | Container: timestamps of each `/new` |

How to read the token numbers:
- **The total is mostly cache re-reads.** Every reply re-reads the whole conversation, so the total
  grows much faster than the output.
- **`context`** is the size of the latest reply's context. Every next reply re-reads that much, so
  a large context means each step costs more.

Not shown yet: **plan usage** (how much of the 5-hour and weekly allowance is spent). The CLI
only exposes it through an undocumented request, so it's left for later.

## Limits to know

- **Routines: 30 fires per hour per routine, and 100 per hour per account.** A "fire" is one API
  call that starts one new session, so only `/new` uses one; follow-ups and reports don't. "Run
  now" on the website counts too. The hour rolls: each fire frees up 60 minutes after it happened.
  JARVIS counts its own fires and refuses a 31st with the time the next slot frees, rather than
  letting the API return 429.
- **The subscription allowance is shared.** JARVIS jobs, your orchestrators and builders all draw
  from the same Max plan, with a rolling 5-hour window and a weekly cap. When the window runs out,
  every session stops until it resets. The container uses nothing while idle.
- **Idle sessions get paused.** A cloud session's VM is reclaimed after a period of inactivity.
  The conversation is kept, but background work in it is lost. Archived sessions reject new messages.
- **Size caps:** a routine fire's text is capped at 65,536 characters, and a Telegram message at
  4,096. `report.sh` trims to 4,000.
- **JARVIS can't list your other sessions.** There's no documented API for listing sessions or
  reading their transcripts from outside, so JARVIS tracks only the sessions it started, and
  sessions have to report out.

## Development

```bash
npm install
npm test        # typecheck + unit tests (fake claude binary and fake fetch, no network)
```

Layout: `src/bot.ts` (Telegram commands), `src/routines.ts` (fire API), `src/cloud.ts` (CLI
wrapper), `src/store.ts` (job list on the volume), `scripts/` (run inside cloud sessions).
