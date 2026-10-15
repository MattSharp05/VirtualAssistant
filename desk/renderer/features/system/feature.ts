import type { FeatureMeta } from "../types";

/** The System window (JD-30): plan usage, routine fires, container health, worker vs chat use today. */
const system: FeatureMeta = {
  id: "system",
  title: "System",
  icon: "system",
  minSize: { width: 380, height: 360 },
  defaultSize: { width: 880, height: 780 },
};
export default system;
