# 0002 — Desk ↔ server: REST + SSE with device keys over Tailscale
**Context.** The Desk needs live pushes (orb state, streamed replies, notifications) and simple requests. The server is reachable only on the tailnet (dashboard via Tailscale Serve :8443) or localhost.
**Decision.** REST endpoints under `/api/desk/*` plus one SSE stream `/api/desk/events`. Each Mac pairs once from the dashboard and gets a device key (stored hashed on the server, in the Keychain on the Mac). Server→Mac requests (folder read, clipboard, screenshot) go out as SSE `rpc` events and come back as `POST /api/desk/rpc/:id`. Types live in `shared/protocol.ts`.
**Alternatives.** WebSockets (bidirectional but more moving parts behind Tailscale Serve); polling (laggy for voice).
**Consequences.** Works unchanged when the server moves to a VPS on the tailnet. SSE reconnects with `Last-Event-ID`; the hub keeps a short replay buffer.
