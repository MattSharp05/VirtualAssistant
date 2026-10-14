# 0006 — Notion holds memory and tasks; writes are scoped in code
**Context.** Matthew wants memory and to-dos he can read and edit in Notion. The integration was read-only.
**Decision.** Turn on Insert/Update content for the JARVIS integration. `npm run setup:notion` creates `JARVIS Memory` (page) and `JARVIS Tasks` (database) under a parent page Matthew shares, and stores their ids in the server store. Write helpers accept only those two ids (anything else throws). Memory is injected into the brain with `--append-system-prompt` at conversation start and refreshed when it changes.
**Consequences.** One Notion round trip per memory write; tasks are cached for the Desk with a 60 s TTL and updated immediately on JARVIS's own writes.
