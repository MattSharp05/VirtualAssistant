import type { FeatureMeta } from "../types";

/** The Notion window (JD-34; mockup 7): search, pinned and recent pages, and a read view of one. */
const notion: FeatureMeta = {
  id: "notion",
  title: "Notion",
  icon: "notion",
  minSize: { width: 720, height: 480 },
  defaultSize: { width: 1200, height: 790 },
};
export default notion;
