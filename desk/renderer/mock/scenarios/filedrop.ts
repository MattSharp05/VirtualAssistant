// File drop (JD-40) for the preview, e2e and snapshots: drag a file from your desktop onto the orb
// (?window=overlay) or the Chat window (?window=chat). The mock bridge "uploads" it with progress and
// JARVIS answers Summarise with a canned summary.
import { chatData } from "../data/chat";
import { sessions } from "../data/sessions";
import type { Scenario } from "../types";

const filedrop: Scenario = {
  name: "filedrop",
  description:
    "Drop a PDF, text file or image on the orb or the Chat window: progress, then Summarise / Ask…; over 20 MB is turned away.",
  data: {
    ...chatData,
    "/mood": { mood: "green", reason: "all fine", dnd: { on: false } },
    "/sessions": sessions,
  },
  events: [],
  chatReply:
    "Q3 report, in short: revenue up 18% to £2.4M, churn down to 3.1%, and two risks flagged: the EU launch slipping to November and hiring for the platform team. The ask is a decision on the pricing change by Friday.",
};

export default filedrop;
