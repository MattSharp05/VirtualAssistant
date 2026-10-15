// Notion as the Notion window shows it (JD-34; mockup 7): JARVIS Tasks and Memory, the Mario Kart
// PRD (pinned, open first), a few recent pages, and the mock notion routes so search, opening
// pages and pinning work in the preview.
import type { NotionBlock, NotionPage, NotionPinnedResponse } from "@jarvis/shared";
import { notionRoutes } from "../notionRoutes";
import type { ScenarioPart } from "../types";

/** Page ids: 32 hex chars, like the server's. */
const id = (n: number) => `3f924983f3ca81${String(n).padStart(18, "0")}`;
export const NOTION_IDS = {
  tasks: id(1),
  memory: id(2),
  mkPrd: id(3),
  tracks: id(4),
  tripTickets: id(5),
  journal: id(6),
  shapemintTdd: id(7),
  projects: id(8),
  tripPrd: id(9),
  shapemintPrd: id(10),
};
const url = (title: string, n: string) => `https://www.notion.so/${title.replace(/\W+/g, "-")}-${n}`;

let blockSeq = 0;
const b = (type: NotionBlock["type"], text?: string, extra: Partial<NotionBlock> = {}): NotionBlock => ({
  id: `b${String(++blockSeq).padStart(31, "0")}`,
  type,
  ...(text !== undefined ? { text } : {}),
  ...extra,
});
const child = (pageId: string, title: string): NotionBlock => ({ id: pageId, type: "child_page", title });

const page = (
  key: keyof typeof NOTION_IDS,
  title: string,
  editedAt: string,
  blocks: NotionBlock[],
  extra: Partial<NotionPage> = {},
): NotionPage => ({
  id: NOTION_IDS[key],
  title,
  kind: "page",
  url: url(title, NOTION_IDS[key]),
  editedAt,
  properties: [],
  blocks,
  ...extra,
});

export const notionPages: NotionPage[] = [
  page(
    "mkPrd",
    "Mario Kart PRD",
    "2026-10-12T16:20:00Z",
    [
      b("heading_1", "Goals"),
      b(
        "paragraph",
        "A browser kart racer with three tracks, local time trials and a ghost of your best lap. Feels fast and readable on a laptop keyboard.",
      ),
      b("bulleted", "Three tracks: Harbour, Canyon, Night City"),
      b("bulleted", "Time trials with a ghost of your best lap", {
        children: [b("bulleted", "Ghosts are saved per track, in the browser")],
      }),
      b("bulleted", "Keyboard first: arrows to steer, space to drift"),
      b("heading_1", "Speed and boosts"),
      b(
        "paragraph",
        "Top speed is capped at 1.2× base. Drift boost may push past the cap for at most 0.8 s.",
      ),
      b("callout", "MK-81 is waiting on a decision: keep drift boost past the cap, or cut it.", {
        icon: "⚠️",
      }),
      b("heading_2", "Milestones"),
      b("todo", "Lap counter and timer", { checked: true }),
      b("todo", "Ghost replay", { checked: true }),
      b("todo", "Drift boost tuning (MK-81)", { checked: false }),
      b("heading_2", "Tuning"),
      b("code", "const SPEED_CAP = 1.2; // × base\nconst DRIFT_BOOST_MAX_S = 0.8;", {
        language: "typescript",
      }),
      b("quote", "If it doesn't feel fast on a laptop, it isn't fast."),
      b("divider"),
      child(NOTION_IDS.tracks, "Track list"),
    ],
    {
      properties: [
        { name: "Status", value: "Approved" },
        { name: "Owner", value: "Matthew" },
      ],
    },
  ),
  page("tracks", "Track list", "2026-10-11T09:00:00Z", [
    b("numbered", "Harbour: wide corners, the tutorial track"),
    b("numbered", "Canyon: a long jump and two hairpins"),
    b("numbered", "Night City: narrow streets, boost pads"),
    b("toggle", "Ideas for later", { children: [b("bulleted", "A mirror mode"), b("bulleted", "Weather")] }),
  ]),
  page(
    "tasks",
    "JARVIS Tasks",
    "2026-10-14T08:41:00Z",
    [
      child(id(101), "QA trip batch 3 (6 tickets)"),
      child(id(102), "Review shapemint build failure"),
      child(id(103), "Renew passport"),
    ],
    { kind: "database" },
  ),
  page("memory", "JARVIS Memory", "2026-10-13T21:05:00Z", [
    b("heading_2", "About Matthew"),
    b("bulleted", "Prefers short answers; UK spelling"),
    b("bulleted", "Works on Mario Kart, Trip planner and Shapemint"),
    b("heading_2", "Preferences"),
    b("bulleted", "No meetings before 9:30"),
    b("bulleted", "QA batches in the evening"),
  ]),
  page(
    "tripTickets",
    "Trip v1 · Tickets",
    "2026-10-14T07:30:00Z",
    [child(id(111), "TR-20 Itinerary view"), child(id(112), "TR-21 Hotel budget")],
    { kind: "database" },
  ),
  page("journal", "Process Journal", "2026-10-13T18:00:00Z", [
    b("heading_2", "13 Oct"),
    b("paragraph", "Batched QA works: three tickets tested in one sitting."),
  ]),
  page("shapemintTdd", "Shapemint TDD", "2026-10-10T12:00:00Z", [
    b("heading_1", "Architecture"),
    b("paragraph", "A Next.js app on Vercel with a Postgres queue for renders."),
  ]),
  page("projects", "Claude Projects", "2026-10-09T10:00:00Z", [
    child(NOTION_IDS.mkPrd, "Mario Kart PRD"),
    child(NOTION_IDS.tripPrd, "Trip planner PRD"),
    child(NOTION_IDS.shapemintPrd, "Shapemint PRD"),
  ]),
  page("tripPrd", "Trip planner PRD", "2026-10-08T15:00:00Z", [
    b("heading_1", "Goals"),
    b("paragraph", "Plan a trip with flights, hotels and a day-by-day itinerary."),
  ]),
  page("shapemintPrd", "Shapemint PRD", "2026-10-02T15:00:00Z", [
    b("heading_1", "Goals"),
    b("paragraph", "Turn a sketch into a 3D-printable model."),
  ]),
];

const ref = (key: keyof typeof NOTION_IDS) => {
  const { id, title, kind, url, editedAt } = notionPages.find((p) => p.id === NOTION_IDS[key])!;
  return { id, title, kind, url, editedAt };
};

/** Tasks and Memory always pinned, plus the PRD; recent newest first (the PRD was opened last). */
export const notionPinned: NotionPinnedResponse = {
  pinned: [{ ...ref("tasks"), fixed: true }, { ...ref("memory"), fixed: true }, ref("mkPrd")],
  recent: [ref("mkPrd"), ref("tripTickets"), ref("journal"), ref("shapemintTdd"), ref("projects")],
};

const part: ScenarioPart = {
  data: { "/notion/pinned": notionPinned },
  routes: [notionRoutes(notionPages)],
};
export default part;
