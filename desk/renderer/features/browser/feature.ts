import type { FeatureMeta } from "../types";

/** The Mac's browser (JD-59): pages JARVIS acts in, which Matthew can watch and take over. */
const browser: FeatureMeta = {
  id: "browser",
  title: "Browser",
  icon: "browser",
  minSize: { width: 560, height: 420 },
  defaultSize: { width: 1040, height: 760 },
};
export default browser;
