// The Today digest (JD-17), typed as the server's Digest so the preview and the real thing match.
import type { BriefResponse, TaskItem, TasksResponse, TodayResponse } from "@jarvis/shared";
import type { ScenarioPart } from "../types";

export const today: TodayResponse = {
  running: false,
  ageSeconds: 420,
  digest: {
    generatedAt: "2026-10-14T08:53:00Z",
    events: [
      {
        start: "2026-10-14T09:30:00+01:00",
        end: "2026-10-14T09:45:00+01:00",
        title: "Standup",
        calendar: "Work",
        link: "https://meet.google.com/abc-defg-hij",
      },
      {
        start: "2026-10-14T12:30:00+01:00",
        end: "2026-10-14T13:30:00+01:00",
        title: "Lunch with Sam",
        location: "Dishoom",
        calendar: "Personal",
      },
      {
        start: "2026-10-14T18:00:00+01:00",
        end: "2026-10-14T19:00:00+01:00",
        title: "Gym",
        calendar: "Personal",
      },
    ],
    inbox: [
      {
        from: "Sam Lee",
        subject: "Lunch tomorrow?",
        line: "Asks whether 12:30 at Dishoom still works.",
        receivedAt: "2026-10-14T07:31:00Z",
      },
      {
        from: "Priya Shah",
        subject: "Onboarding copy",
        line: "Wants your review of the new onboarding copy by Thursday.",
        receivedAt: "2026-10-14T06:58:00Z",
      },
    ],
    skippedCount: 14,
    slack: [
      {
        who: "Priya",
        where: "#gogentic",
        line: "Can you review the onboarding copy today?",
        at: "2026-10-14T08:20:00Z",
      },
    ],
    tasksDue: [
      {
        id: "t1",
        name: "Answer trip: hotel budget",
        status: "Open",
        due: "2026-10-14",
        source: "Session",
        createdAt: "2026-10-13T18:00:00Z",
      },
      {
        id: "t2",
        name: "Review onboarding copy for Priya",
        status: "Open",
        due: "2026-10-14",
        source: "Slack",
        createdAt: "2026-10-14T08:21:00Z",
      },
    ],
    sessionsWaiting: [
      {
        job: "trip",
        status: "decision",
        line: "TR-14 needs a decision: hotel budget cap?",
        at: "2026-10-14T08:40:00Z",
      },
    ],
  },
};

const due = today.digest!.tasksDue;
const withStatus = (t: TaskItem, status: TaskItem["status"]): TaskItem => ({ ...t, status });
const brief: BriefResponse = { messageId: "brief-1" };
const dueToday: TasksResponse = { view: "today", tasks: due };

/** What the Today window's buttons call (JD-33): refresh, tick or untick a to-do, play the brief. */
export const todayActions: Record<string, unknown> = {
  "/today/refresh": { started: true },
  "/tasks?view=today": dueToday,
  ...Object.fromEntries(
    due.flatMap((t) => [
      [`/tasks/${t.id}/done`, withStatus(t, "Done")],
      [`/tasks/${t.id}/reopen`, withStatus(t, "Open")],
    ]),
  ),
  "/brief": brief,
};

const part: ScenarioPart = { data: { "/today": today, ...todayActions } };

export default part;
