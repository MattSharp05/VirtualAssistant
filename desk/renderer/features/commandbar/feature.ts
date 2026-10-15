import type { FeatureMeta } from "../types";

/**
 * The command bar (JD-28, mockup 2): ⌘⇧Space opens it centred over whatever app is in front. Its own
 * frameless window (main/windows/commandbar.ts), so no glass frame and no launcher button.
 */
const commandbar: FeatureMeta = {
  id: "commandbar",
  title: "Command bar",
  icon: "search",
  framed: false,
  defaultSize: { width: 680, height: 480 },
};
export default commandbar;
