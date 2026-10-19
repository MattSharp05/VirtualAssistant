// A browser task's results (JD-66), for the preview, e2e and snapshots: JARVIS found one-way flights
// from Tampa to Johannesburg and left them in the task sidebar. Rows with their own page open in the
// Browser window; a row without one, or a question typed under any row, picks the task back up and the
// answer lands in the log. `browser-task-results-closed` has the sidebar closed: the pill shows the result.
import type { BrowserState, BrowserTask } from "@jarvis/shared";
import { browserTaskRoutes, pastTasks, tasksData } from "../browserTasks";
import type { Scenario } from "../types";

const NOW = "2026-10-22T18:52:00Z";
const SEARCH = "https://flights.example/search?from=TPA&to=JNB&dates=2026-12-10..12";

const flights: BrowserTask = {
  id: "task-jnb",
  text: "Find one-way flights, Tampa to Johannesburg, Dec 10–12 2026",
  mode: "normal",
  status: "done",
  origin: "browser",
  startedAt: "2026-10-22T18:45:00Z",
  endedAt: "2026-10-22T18:49:10Z",
  result: "Found 7 options. Cheapest is Fri Dec 11 at $958 (JetBlue + Turkish, 2 stops). Nothing booked.",
  results: {
    title: "Tampa → Johannesburg, one way, Dec 10–12",
    items: [
      {
        label: "Fri Dec 11 · JetBlue + Turkish, 2 stops",
        detail: "$958",
        url: "https://flights.example/fare/tpa-jnb-dec11-958",
      },
      {
        label: "Thu Dec 10 · Air Canada + Emirates, 2 stops",
        detail: "$1,188",
        url: "https://flights.example/fare/tpa-jnb-dec10-1188",
      },
      { label: "Sat Dec 12 · cheapest date in the window", detail: "$1,018" },
      {
        label: "Fri Dec 11 · Delta + KLM, 1 stop",
        detail: "$1,342",
        url: "https://flights.example/fare/tpa-jnb-dec11-1342",
      },
    ],
  },
  steps: 5,
  log: [
    {
      at: "2026-10-22T18:45:00Z",
      kind: "start",
      text: "Normal: Find one-way flights, Tampa to Johannesburg, Dec 10–12 2026",
    },
    {
      at: "2026-10-22T18:45:20Z",
      kind: "action",
      text: "Setting Tampa (TPA) → Johannesburg (JNB), one way",
      url: SEARCH,
    },
    { at: "2026-10-22T18:46:30Z", kind: "action", text: "Setting dates: Dec 10–12, 2026", url: SEARCH },
    { at: "2026-10-22T18:48:00Z", kind: "action", text: "Sorting by price", url: SEARCH },
    {
      at: "2026-10-22T18:49:10Z",
      kind: "done",
      text: "Found 7 options. Cheapest is Fri Dec 11 at $958 (JetBlue + Turkish, 2 stops). Nothing booked.",
    },
  ],
};

const page: BrowserState = {
  tabs: [{ id: "tab-1", url: SEARCH, title: "TPA → JNB · Flights", active: true }],
  url: SEARCH,
  title: "TPA → JNB · Flights",
  canGoBack: true,
  canGoForward: false,
  loading: false,
  control: "jarvis",
  status: "",
};

const results = (name: string, description: string, ui: Scenario["ui"] = {}): Scenario => ({
  name,
  description,
  data: tasksData([flights, ...pastTasks]),
  events: [],
  routes: [browserTaskRoutes],
  browser: page,
  ui: { now: NOW, ...ui },
});

const scenarios: Scenario[] = [
  results(
    "browser-task-results",
    "Browser task done: its flights in the sidebar's results. A row with a page opens it; asking under a row picks the task back up and the answer lands in the log.",
  ),
  results(
    "browser-task-results-closed",
    "Browser task done with the sidebar closed: the pill reads “Done · show the result” and reopens the results.",
    { taskPanelClosed: true },
  ),
];

export default scenarios;
