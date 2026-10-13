# Tailscale sidecar

`serve.json` decides what Tailscale exposes, and it opens exactly two doors:

| Address | Goes to | Who can reach it |
|---|---|---|
| `https://jarvis.<tailnet>.ts.net` (port 443) | the dashboard (`jarvis:8080`) | only devices signed in to your tailnet (Serve) |
| `https://jarvis.<tailnet>.ts.net:8443` | the reports-only server (`jarvis:8081`) | the internet (Funnel), but it accepts only `POST /api/reports` with `REPORT_SECRET` |

`${TS_CERT_DOMAIN}` is filled in by the container with the machine's real name. Edit this file and
run `docker compose up -d` to apply changes.
