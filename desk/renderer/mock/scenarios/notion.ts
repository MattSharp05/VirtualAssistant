// The Notion window (JD-34; mockup 7): pinned and recent pages with the Mario Kart PRD open; and the
// same window while Notion isn't connected (search and pages explain what to do).
import { notionPages, notionPinned } from "../data/notion";
import { notionRoutes } from "../notionRoutes";
import type { Scenario } from "../types";

const scenarios: Scenario[] = [
  {
    name: "notion",
    description:
      "Notion: JARVIS Tasks, Memory and the Mario Kart PRD pinned, four recent pages; search, read view, pin, Ask JARVIS.",
    data: { "/notion/pinned": notionPinned },
    events: [],
    routes: [notionRoutes(notionPages)],
    chatReply: "The Mario Kart PRD is approved. The one open item is MK-81, drift boost tuning.",
  },
  {
    name: "notion-off",
    description: "Notion while NOTION_TOKEN isn't set: nothing pinned yet, and search says what to do.",
    data: { "/notion/pinned": { pinned: [], recent: [] } },
    events: [],
    routes: [notionRoutes([], { fail: "Notion isn't connected: NOTION_TOKEN is not set in JARVIS's .env." })],
  },
];

export default scenarios;
