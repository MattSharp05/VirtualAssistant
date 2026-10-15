import type { FeatureMeta } from "../types";

/** One place for today (JD-33, mockup 5): calendar, inbox and Slack, to-dos due, sessions waiting. */
const today: FeatureMeta = {
  id: "today",
  title: "Today",
  icon: "today",
  minSize: { width: 420, height: 360 },
  defaultSize: { width: 1240, height: 790 },
};
export default today;
