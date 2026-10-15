import type { FeatureMeta } from "../types";

/** Settings (JD-26): the server and pairing, voice, hotkeys, wake word, folders, faces, updates. */
const settings: FeatureMeta = {
  id: "settings",
  title: "Settings",
  icon: "settings",
  minSize: { width: 540, height: 420 },
  defaultSize: { width: 780, height: 640 },
};
export default settings;
