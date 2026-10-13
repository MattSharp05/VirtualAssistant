// Prints your cloud sessions the way the dashboard's picker sees them:
//   docker compose exec jarvis npm run -s sessions

import { loadConfig } from "./config.js";
import { listCloudSessions } from "./sessions.js";

const list = await listCloudSessions(loadConfig().claudeBin);
if (!list.available) {
  console.log(`not available: ${list.reason}`);
  process.exit(1);
}
console.log(`${list.sessions.length} sessions (via ${list.source === "agents" ? "claude agents --json" : "the session list API"}):`);
for (const s of list.sessions.slice(0, 20)) {
  console.log(`  ${s.lastActivityAt?.slice(0, 16).replace("T", " ") ?? "                "}  ${s.status ?? ""}\t${s.title}`);
}
