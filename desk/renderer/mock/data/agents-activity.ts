// What the Agents window's side panel (JD-58) shows as a node's latest activity: GET /sessions/:id for
// the agent graph's sessions (mock/data/agents.ts), the last history line of each. The rest answer
// without history, so the panel falls back to their last activity time.
import type { AgentSession, SessionDetail } from "@jarvis/shared";
import type { ScenarioPart } from "../types";
import { projects } from "./agents";

const LAST: Record<string, string> = {
  session_01JDorch13: "JD-57 CI failed on server; asked its builder to look at the agents route test.",
  session_01JD54: "Wrote the metrics tests; running the desk suite.",
  session_01JD55: "Pushed the usage table; waiting on CI for PR #71.",
  session_01JD57: "server › agents.test.ts failed: expected 3 builders, got 2. Looking into lineage.",
  session_01TRorch: "TR-20 is in review; TR-22 has no session yet.",
};

const sessions: AgentSession[] = projects.flatMap((p) => [
  ...p.orchestrators.flatMap((o) => [
    o.session,
    ...o.builders.flatMap((b) => (b.session ? [b.session] : [])),
  ]),
  ...p.loose.flatMap((b) => (b.session ? [b.session] : [])),
]);

export const activityData: Record<string, SessionDetail> = Object.fromEntries(
  sessions.map((s): [string, SessionDetail] => [
    `/sessions/${s.id}`,
    {
      session: {
        id: s.id,
        sessionId: s.id,
        title: s.title,
        url: s.url,
        group: "working",
        ...(s.status ? { status: s.status } : {}),
        ...(s.lastActivity ? { lastActivity: s.lastActivity } : {}),
        ...(s.metrics ? { metrics: s.metrics } : {}),
      },
      activity: LAST[s.id]
        ? { available: true, items: [{ at: s.lastActivity, role: "assistant", text: LAST[s.id]! }] }
        : { available: false, items: [], reason: "no history" },
      reports: [],
      link: s.url,
    },
  ]),
);

const part: ScenarioPart = { data: activityData };
export default part;
