// The System window (JD-30): the dashboard's tiles for the Desk.
//   GET  /api/desk/system → SystemResponse (plan usage, routine fires, container, brain use today, devices,
//        voice latency over the last 20 voice turns)
//        and cloud sessions' use per project and per day over the last 30 days (JD-55)
//   POST /api/desk/system/latency VoiceLatencyTurn → { ok } (the Desk, after every voice turn; JD-48)
// Plan usage and fires come from jarvis.status() (cached like the dashboard's), the container from the
// SystemMonitor index.ts registers, the chat's and worker's use today from their message logs.
import type { BrainUsageToday, SystemResponse } from "@jarvis/shared";
import { WorkerState } from "../../brain/worker.js";
import type { BrainMessage } from "../../store.js";
import { SessionUsageLog } from "../../sessionUsage.js";
import { systemMonitorFor } from "../../system.js";
import { parseLatencyTurn, VoiceLatencyLog } from "../../voiceLatency.js";
import { DeskHttpError, type DeskRoute } from "./index.js";

/** Midnight today in the server's time zone (TZ), as ms. */
export function startOfDay(now: Date): number {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** Sums the replies (messages with metrics) since `since`. */
export function usageSince(messages: readonly BrainMessage[], since: number): BrainUsageToday {
  const out: BrainUsageToday = { replies: 0, tokens: 0, turns: 0, ms: 0 };
  for (const { at, metrics: m } of messages) {
    if (!m || Date.parse(at) < since) continue;
    out.replies++;
    out.tokens += m.inputTokens + m.cacheReadTokens + m.cacheWriteTokens + m.outputTokens;
    out.turns += m.turns;
    out.ms += m.ms;
  }
  return out;
}

const routes: DeskRoute[] = [
  {
    method: "GET",
    path: "/system",
    handler: async ({ ctx }): Promise<SystemResponse> => {
      const { jarvis, devices } = ctx;
      const status = await jarvis.status();
      const window = (name: "five_hour" | "seven_day") => status.usage.windows.find((w) => w.name === name);
      const five = window("five_hour");
      const week = window("seven_day");
      const { current: c, history } = systemMonitorFor(jarvis).stats();
      const since = startOfDay(new Date());
      // The worker writes worker.json as it goes; a fresh read sees its latest jobs.
      const worker = new WorkerState(jarvis.config.dataDir).brain();
      return {
        checkedAt: new Date().toISOString(),
        plan: {
          available: status.usage.available,
          fiveHour: five?.percent ?? null,
          weekly: week?.percent ?? null,
          ...(five?.resetsAt ? { resetsAt: five.resetsAt } : {}),
          ...(week?.resetsAt ? { weeklyResetsAt: week.resetsAt } : {}),
          ...(status.usage.reason ? { reason: status.usage.reason } : {}),
        },
        fires: {
          configured: status.routineConfigured,
          used: status.firesThisHour,
          limit: status.firesPerHour,
          ...(status.nextFireFreesAt ? { nextFreeAt: status.nextFireFreesAt } : {}),
        },
        container: {
          memUsed: c.memoryUsed,
          memLimit: c.memoryLimit,
          memPeak: c.memoryPeak,
          cpu: c.cpuPercent,
          claudeProcs: c.claudeProcesses,
          uptimeSeconds: c.uptimeSeconds,
          memHistory: history.map((h) => ({ at: h.at, memUsed: h.memoryUsed })),
        },
        brain: {
          chatToday: usageSince(jarvis.store.brain().messages, since),
          workerToday: usageSince(worker.messages, since),
        },
        devices: devices.list(),
        voiceLatency: new VoiceLatencyLog(jarvis.config.dataDir).summary(),
        // From the hourly snapshots index.ts records (no session API calls on this 15 s poll).
        ...new SessionUsageLog(jarvis.config.dataDir).summary(),
      };
    },
  },
  {
    method: "POST",
    path: "/system/latency",
    handler: ({ body, ctx }) => {
      let turn;
      try {
        turn = parseLatencyTurn(body);
      } catch (err) {
        throw new DeskHttpError(400, (err as Error).message);
      }
      new VoiceLatencyLog(ctx.jarvis.config.dataDir).add(turn);
      return { ok: true };
    },
  },
];

export default routes;
