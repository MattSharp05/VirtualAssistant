// Timers and reminders (src/scheduler.ts). Due ones ping Matthew on Telegram and the Desk.
import { schedulerFor, type ScheduledItem, type Scheduler } from "../scheduler.js";
import { schema, str, type ToolGroup } from "./types.js";

function line(s: Scheduler, i: ScheduledItem): string {
  return `- ${i.kind === "timer" ? "⏱ timer" : "🔔 reminder"} ${i.text ? `"${i.text}" ` : ""}at ${s.clock(i.at)} [id ${i.id}]`;
}

const group: ToolGroup = {
  name: "timers",
  promptHint: (ctx) =>
    `- Timers and reminders: set_timer for "N-minute timer"; set_reminder when he wants a nudge at a specific time (give \`at\` as ISO with his UTC offset; his time zone is ${ctx.config.timeZone ?? "Europe/London"}). Reminders without a time are tasks, not reminders. Tell him when it will go off.`,
  tools: [
    {
      name: "set_timer",
      description: "Start a countdown timer. Matthew gets a Telegram message and a Desk alert when it ends.",
      inputSchema: schema({ minutes: { type: "number", description: "Length in minutes (decimals allowed)" }, label: str("What it's for (optional)") }, ["minutes"]),
      handler: async (a, ctx) => {
        const s = schedulerFor(ctx.jarvis);
        const t = s.setTimer(Number(a.minutes), a.label ? String(a.label) : undefined);
        return `Timer set${t.text ? ` for ${t.text}` : ""}: ends at ${s.clock(t.at)} [id ${t.id}].`;
      },
    },
    {
      name: "set_reminder",
      description: "Remind Matthew of something at a specific date and time (Telegram + Desk).",
      inputSchema: schema({ at: str("When, ISO 8601 with offset, e.g. 2026-10-17T09:00:00+01:00"), text: str("What to remind him of") }, ["at", "text"]),
      handler: async (a, ctx) => {
        const s = schedulerFor(ctx.jarvis);
        const r = s.setReminder(String(a.at ?? ""), String(a.text ?? ""));
        return `Reminder set for ${s.clock(r.at)}: ${r.text} [id ${r.id}].`;
      },
    },
    {
      name: "list_timers",
      description: "List running timers and upcoming reminders.",
      inputSchema: schema({}),
      handler: async (_a, ctx) => {
        const s = schedulerFor(ctx.jarvis);
        const items = s.list();
        return items.length ? items.map((i) => line(s, i)).join("\n") : "No timers or reminders.";
      },
    },
    {
      name: "cancel_timer",
      description: "Cancel a timer or reminder by id (from list_timers).",
      inputSchema: schema({ id: str("Timer or reminder id") }, ["id"]),
      handler: async (a, ctx) => {
        const s = schedulerFor(ctx.jarvis);
        const i = s.cancel(String(a.id ?? ""));
        return `Cancelled the ${i.kind}${i.text ? ` "${i.text}"` : ""} (was due ${s.clock(i.at)}).`;
      },
    },
  ],
};

export default group;
