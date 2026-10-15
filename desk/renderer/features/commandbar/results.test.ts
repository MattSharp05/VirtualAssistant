import { describe, expect, it } from "vitest";
import type { DeskSession } from "@jarvis/shared";
import { fuzzyScore } from "./fuzzy";
import { buildResults, layoutHits, MAX_MATCHES, notionHits, type Sources } from "./results";

const session = (id: string, title: string, name: string | undefined = id): DeskSession => ({
  id,
  ...(name ? { name } : {}),
  sessionId: `session_${id}`,
  title,
  group: "idle",
  url: `https://claude.ai/code/session_${id}`,
});

const sources: Sources = {
  windows: [
    { id: "chat", title: "Chat", icon: "chat" },
    { id: "sessions", title: "Sessions", icon: "sessions" },
    { id: "today", title: "Today", icon: "today" },
    { id: "todo", title: "To-do", icon: "todo" },
  ],
  sessions: [
    session("trip", "Trip planner orchestrator"),
    session("mk-80-builder", "MK-80 track hazards"),
    session("mk", "Mario Kart orchestrator"),
    session("session_01SM", "ShapeMint: refactor export pipeline", ""),
  ],
  // What Notion's search found for "mk".
  notion: [{ id: "p1", title: "Mario Kart PRD" }],
  layouts: [{ name: "Work mode", windows: ["chat", "sessions"] }],
};

const labels = (text: string, s = sources) => buildResults(text, s).map((r) => `${r.kind}:${r.label}`);

describe("fuzzy ranking", () => {
  it("puts exact and prefix matches before initials and loose matches", () => {
    expect(fuzzyScore("mk", "mk")).toBeGreaterThan(fuzzyScore("mk", "mk-80-builder"));
    expect(fuzzyScore("mk", "mk-80-builder")).toBeGreaterThan(fuzzyScore("mk", "Mario Kart PRD"));
    expect(fuzzyScore("tod", "Today")).toBeGreaterThan(fuzzyScore("tod", "To-do"));
    expect(fuzzyScore("kart", "Mario Kart PRD")).toBeGreaterThan(fuzzyScore("art", "Mario Kart PRD"));
    expect(fuzzyScore("art", "Mario Kart PRD")).toBeGreaterThan(fuzzyScore("mrk", "Mario Kart PRD"));
    expect(fuzzyScore("xyz", "Mario Kart PRD")).toBe(0);
    expect(fuzzyScore("CAFE", "Café notes")).toBeGreaterThan(0);
  });

  it("“mk” lists session mk before mk-80-builder and the Mario Kart PRD, and Ask JARVIS last", () => {
    expect(labels("mk")).toEqual([
      "session:mk",
      "session:mk-80-builder",
      "notion:Mario Kart PRD",
      "ask:Ask JARVIS: “mk”",
    ]);
  });

  it("matches a session by its title and a window by its name", () => {
    expect(labels("shapemint")[0]).toBe("session:ShapeMint: refactor export pipeline");
    expect(labels("today")[0]).toBe("window:Today");
    expect(labels("work")[0]).toBe("layout:Work mode");
  });

  it("keeps at most 8 matches and always ends with Ask JARVIS", () => {
    const many: Sources = {
      ...sources,
      sessions: Array.from({ length: 12 }, (_, i) => session(`job-${i}`, `Job ${i}`)),
    };
    const results = buildResults("job", many);
    expect(results).toHaveLength(MAX_MATCHES + 1);
    expect(results.at(-1)).toEqual({ kind: "ask", key: "ask", label: "Ask JARVIS: “job”", text: "job" });
    expect(labels("nothing matches this", { ...sources, notion: [] })).toEqual([
      "ask:Ask JARVIS: “nothing matches this”",
    ]);
  });

  it("keeps what Notion's search found even when the title alone doesn't match", () => {
    expect(labels("drift", { ...sources, notion: [{ id: "p3", title: "MK-81 decision log" }] })).toEqual([
      "notion:MK-81 decision log",
      "ask:Ask JARVIS: “drift”",
    ]);
  });

  it("lists the windows (and no Ask row) before anything is typed", () => {
    expect(labels("  ")).toEqual(["window:Chat", "window:Sessions", "window:Today", "window:To-do"]);
  });
});

describe("source parsing", () => {
  it("reads Notion hits from a list or a { results } / { pages } answer", () => {
    const page = { id: "p", title: "PRD", url: "https://notion.so/p" };
    expect(notionHits([page])).toEqual([{ id: "p", title: "PRD" }]);
    expect(notionHits({ results: [page, { id: 3 }] })).toEqual([{ id: "p", title: "PRD" }]);
    expect(notionHits({ pages: [page] })).toEqual([{ id: "p", title: "PRD" }]);
    expect(notionHits(undefined)).toEqual([]);
  });

  it("reads layouts and the windows they open", () => {
    expect(
      layoutHits({ "Work mode": { windows: ["chat", { id: "today", bounds: {} }] }, Bare: ["todo"] }),
    ).toEqual([
      { name: "Work mode", windows: ["chat", "today"] },
      { name: "Bare", windows: ["todo"] },
    ]);
    expect(layoutHits({ Odd: 3 })).toEqual([{ name: "Odd", windows: [] }]);
    expect(layoutHits(undefined)).toEqual([]);
  });
});
