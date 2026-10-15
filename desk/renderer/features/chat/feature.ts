import type { FeatureMeta } from "../types";

/** The chat window (JD-29, mockup 3): the whole conversation, shared with Telegram and the dashboard. */
const chat: FeatureMeta = {
  id: "chat",
  title: "Chat",
  icon: "chat",
  minSize: { width: 420, height: 420 },
  defaultSize: { width: 780, height: 780 },
};
export default chat;
