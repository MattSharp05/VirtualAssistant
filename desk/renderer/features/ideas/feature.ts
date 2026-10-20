import type { FeatureMeta } from "../types";

/** The Ideas window (JD-73): quick capture tagged to a project, then a to-do, a chat or a session. */
const ideas: FeatureMeta = {
  id: "ideas",
  title: "Ideas",
  icon: "idea",
  minSize: { width: 760, height: 480 },
  defaultSize: { width: 1180, height: 760 },
};
export default ideas;
