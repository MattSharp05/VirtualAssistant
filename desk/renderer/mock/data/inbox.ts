// Email + Slack in one Inbox (mockup: Inbox window).
import type { ScenarioPart } from "../types";

const part: ScenarioPart = {
  data: {
    "/inbox": {
      email: [
        {
          id: "m1",
          from: "Vercel",
          subject: "Deployment ready: jarvis-desk",
          at: "2026-10-14T08:55:00Z",
          unread: true,
        },
        { id: "m2", from: "Sam Lee", subject: "Lunch tomorrow?", at: "2026-10-14T07:31:00Z", unread: true },
      ],
      slack: [
        {
          id: "s1",
          channel: "#gogentic",
          from: "Priya",
          text: "Can you review the onboarding copy today?",
          at: "2026-10-14T08:20:00Z",
        },
      ],
    },
  },
};

export default part;
