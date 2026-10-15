// To-do suggestions (JD-22; mockup 6): what JARVIS proposes from sessions, Notion QA, Slack and
// email, waiting for accept / dismiss in the To-do window (JD-36).
import type { TasksResponse } from "@jarvis/shared";
import type { ScenarioPart } from "../types";

const suggested: TasksResponse = {
  view: "suggested",
  tasks: [
    {
      id: "s1",
      name: "Decide TR-14: hotel budget cap?",
      status: "Suggested",
      source: "Session",
      sourceLink: "https://claude.ai/code/session_01TRIP",
      why: "trip is waiting on your decision: “TR-14 needs a decision: hotel budget cap?”",
      createdAt: "2026-10-14T08:12:00Z",
    },
    {
      id: "s2",
      name: "QA JARVIS Desk batch (3 tickets)",
      status: "Suggested",
      project: "JARVIS Desk",
      source: "Notion QA",
      sourceLink: "https://www.notion.so/JARVIS-Desk",
      why: "JD-19, JD-20, JD-21 are waiting for your QA in JARVIS Desk.",
      createdAt: "2026-10-14T08:30:00Z",
    },
    {
      id: "s3",
      name: "Review the onboarding copy for Priya",
      status: "Suggested",
      due: "2026-10-16",
      source: "Slack",
      sourceLink: "https://gogentic.slack.com/archives/C01/p1760430000",
      why: "Priya asked in #gogentic for a review by Thursday.",
      createdAt: "2026-10-14T08:40:00Z",
    },
    {
      id: "s4",
      name: "Send passport scan to the travel agent",
      status: "Suggested",
      source: "Email",
      sourceLink: "https://mail.google.com/mail/u/0/#inbox/18f2a",
      why: "Atlas Travel emailed yesterday asking for it before booking.",
      createdAt: "2026-10-14T08:45:00Z",
    },
  ],
};

const part: ScenarioPart = {
  data: { "/tasks?view=suggested": suggested },
};

export default part;
