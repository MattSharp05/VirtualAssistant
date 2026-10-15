// The command bar (JD-28): Matthew's sessions, a Notion search that finds the Mario Kart pages, and a
// saved layout, so typing "mk" lists session mk first, then mk-80-builder, then the Notion pages.
import type { MockRoute, Scenario } from "../types";
import { sessions } from "../data/sessions";

const pages = [
  { id: "page-mk-prd", title: "Mario Kart PRD" },
  { id: "page-mk-tdd", title: "Mario Kart · Technical design" },
  { id: "page-trip-prd", title: "Trip planner PRD" },
  { id: "page-memory", title: "JARVIS Memory" },
  { id: "page-weekly", title: "Weekly review" },
];
// Notion's search finds "Mario Kart" for "mk" too, so the mock matches initials as well as words.
const initials = (title: string) =>
  title
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((w) => w[0])
    .join("")
    .toLowerCase();

const notionSearch: MockRoute = (path) => {
  if (!path.startsWith("/notion/search")) return undefined;
  const q = (new URLSearchParams(path.split("?")[1]).get("q") ?? "").toLowerCase();
  return {
    results: pages.filter((p) => p.title.toLowerCase().includes(q) || initials(p.title).startsWith(q)),
  };
};

const commandbar: Scenario = {
  name: "commandbar",
  description: "Command bar (⌘⇧Space): sessions, Notion pages and a “Work mode” layout to search.",
  data: { "/sessions": sessions },
  routes: [notionSearch],
  events: [],
  settings: { layouts: { "Work mode": { windows: ["chat", "sessions", "today"] } } },
  chatReply: "mk is blocked on MK-81: drift boost vs the PRD speed cap. Want me to open it?",
};

export default commandbar;
