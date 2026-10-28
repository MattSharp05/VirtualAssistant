# Moving JARVIS from the Mac to a VPS

The server (`src/`) already runs as a plain Docker Compose stack with a Tailscale sidecar; its own
comments call out "a laptop or a VPS alike" (`docker-compose.yml`). This is an ops move, not a code
change — nothing here is wired up by this pass, it's the runbook for when Matthew's ready to do it.

## Pick a box
A small, cheap VPS is plenty — JARVIS idles around 25–100 MB and caps at 1 GB (`mem_limit` in
`docker-compose.yml`). A Hetzner CX22 (~€4–5/mo) or DigitalOcean's $6/mo droplet both work; anything
with Docker support and a couple of GB of RAM is fine. Ubuntu/Debian is the easiest base image.

## Steps
1. **Provision the box**, install Docker + the Compose plugin.
2. **Copy the repo** (`git clone` the same repo the Mac container runs from) and the `.env` file
   (never commit it — copy it over `scp`/a password manager, not through git).
3. **Bring the data with you.** On the Mac: `docker compose exec jarvis tar czf - -C /data . >
   jarvis-data.tgz` (or `docker run --rm -v jarvis-data:/data -v $PWD:/backup alpine tar czf
   /backup/jarvis-data.tgz -C /data .`), copy the tarball to the VPS, then on the VPS: create the
   volume (`docker volume create jarvis-data`) and extract the tarball into it the same way, before
   the first `docker compose up`.
4. **`docker compose up -d --build`** on the VPS, same as today.
5. **Re-authenticate the Claude subscription.** Auth is `claude auth login` run inside the container
   (not an API key — see `.env.example`'s "Starting cloud sessions" section), tied to Matthew's own
   subscription session. This has to be done once on the new box by Matthew himself; it can't be
   copied from the Mac's container state.
6. **Tailscale:** keep the same `TS_HOSTNAME` in `.env` so the tailnet address
   (`https://jarvis.<tailnet>.ts.net`) doesn't change — then nothing on Desk's `serverUrl` or the
   dashboard needs updating. If the hostname does change, update Desk's Settings → Connection →
   Server URL to match.
7. **Verify:** the dashboard at the Tailscale address, a Telegram message gets a reply, and a Desk
   reconnect (Settings → Connection → the pairing/connection test) all work before decommissioning
   the Mac's container.
8. **Decommission (optional):** once the VPS is confirmed working, `docker compose down` on the Mac.
   Keep its data volume around for a few days in case a rollback is needed.

## Open questions only Matthew can answer
- Which provider/box, and should I provision it myself (needs SSH access handed to me) or do you
  want to do steps 1–2 and hand me the rest?
- Keep the Mac container as a standby/dev instance, or retire it once the VPS is live?
