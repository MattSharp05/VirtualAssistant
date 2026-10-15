// The Today window (JD-33): the demo day, the same day gone stale, and a quiet day with nothing in it.
import type { Digest, TodayResponse } from "@jarvis/shared";
import { today, todayActions } from "../data/today";
import type { Scenario } from "../types";

const digest = today.digest!;

const one = (
  name: string,
  description: string,
  response: TodayResponse,
  more: Record<string, unknown> = {},
): Scenario => ({
  name,
  description,
  data: { "/today": response, ...todayActions, ...more },
  events: [],
});

const quiet: Digest = {
  generatedAt: digest.generatedAt,
  events: [],
  inbox: [],
  skippedCount: 0,
  slack: [],
  tasksDue: [],
  sessionsWaiting: [],
};

const scenarios: Scenario[] = [
  one(
    "today",
    "Today: calendar with next-up, inbox worth reading, Slack, to-dos due and sessions waiting.",
    today,
  ),
  one(
    "today-stale",
    "Today, but the digest is 2 h 20 min old (the last refresh failed): the stale indicator shows.",
    {
      ...today,
      ageSeconds: 8400,
      digest: { ...digest, generatedAt: "2026-10-14T06:40:00Z" },
      lastError: "Gmail connector timed out",
    },
  ),
  one(
    "today-empty",
    "A quiet day: nothing on the calendar, inbox, Slack, to-dos or sessions.",
    { running: false, ageSeconds: 300, digest: quiet },
    { "/tasks?view=today": { view: "today", tasks: [] } },
  ),
];

export default scenarios;
