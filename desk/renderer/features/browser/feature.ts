import type { FeatureMeta } from "../types";

/** The Mac's browser (JD-59): pages JARVIS acts in, which Matthew can watch and take over. */
const browser: FeatureMeta = {
  id: "browser",
  title: "Browser",
  icon: "browser",
  minSize: { width: 760, height: 480 },
  // Wide enough for the page beside the task sidebar (JD-65).
  defaultSize: { width: 1180, height: 780 },
};
export default browser;
