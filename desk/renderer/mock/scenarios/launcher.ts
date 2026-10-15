// The launcher ring (JD-20) for the preview, e2e and snapshots.
import type { Scenario } from "../types";

const launcher: Scenario = {
  name: "launcher-open",
  description: "The orb's launcher ring is open: Chat, Sessions, Today, To-do, Notion, System.",
  data: { "/mood": { mood: "green" } },
  events: [],
  ui: { launcherOpen: true },
};

export default launcher;
