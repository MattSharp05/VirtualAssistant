import type { FeatureMeta } from "../types";

/** The Agents window (JD-58): projects → orchestrators → builders as a pannable, zoomable tree. */
const agents: FeatureMeta = {
  id: "agents",
  title: "Agents",
  icon: "agents",
  minSize: { width: 720, height: 480 },
  defaultSize: { width: 1200, height: 760 },
};
export default agents;
