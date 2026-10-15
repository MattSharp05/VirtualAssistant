// The Notion window's routes in the mock bridge (JD-34), like src/desk/routes/notion.ts does against
// Notion: search by title, read a page, pins and the last 10 opened. Pins and recent start from the
// scenario's `/notion/pinned` data and change as the window pins, unpins and opens pages.
import type { NotionPage, NotionPageRef, NotionPinnedResponse, NotionSearchResponse } from "@jarvis/shared";
import type { MockRoute } from "./types";

const STORE = "mock:notion";
const RECENT_MAX = 10;

const refOf = ({ id, title, kind, url, editedAt }: NotionPage): NotionPageRef => ({
  id,
  title,
  kind,
  ...(url ? { url } : {}),
  ...(editedAt ? { editedAt } : {}),
});

function state(data: Record<string, unknown>): NotionPinnedResponse {
  data[STORE] ??= structuredClone(
    (data["/notion/pinned"] as NotionPinnedResponse | undefined) ?? { pinned: [], recent: [] },
  );
  return data[STORE] as NotionPinnedResponse;
}

/** The notion routes over `pages`; with `fail`, search and page reads fail with that message. */
export function notionRoutes(pages: NotionPage[], opts: { fail?: string } = {}): MockRoute {
  const byId = new Map(pages.map((p) => [p.id, p]));
  return (path, body, { data }) => {
    if (!path.startsWith("/notion/")) return undefined;
    const search = /^\/notion\/search\?q=(.*)$/.exec(path);
    if (search) {
      if (opts.fail) throw new Error(opts.fail);
      const query = decodeURIComponent(search[1]!.replace(/\+/g, " "));
      const q = query.trim().toLowerCase();
      const results = pages
        .filter((p) => p.title.toLowerCase().includes(q))
        .sort((a, b) => (b.editedAt ?? "").localeCompare(a.editedAt ?? ""))
        .map(refOf);
      return { query, results } satisfies NotionSearchResponse;
    }
    const page = /^\/notion\/page\/([0-9a-f]{32})$/.exec(path);
    if (page) {
      if (opts.fail) throw new Error(opts.fail);
      const found = byId.get(page[1]!);
      if (!found) throw new Error("Notion 404 (not found, or not shared with the JARVIS integration)");
      const s = state(data);
      s.recent = [refOf(found), ...s.recent.filter((r) => r.id !== found.id)].slice(0, RECENT_MAX);
      return found;
    }
    if (path === "/notion/pinned") return state(data);
    const pin = /^\/notion\/pinned\/([0-9a-f]{32})(\/unpin)?$/.exec(path);
    if (pin) {
      const s = state(data);
      const id = pin[1]!;
      if (pin[2]) {
        if (s.pinned.some((p) => p.id === id && p.fixed))
          throw new Error("JARVIS Tasks and JARVIS Memory are always pinned.");
        s.pinned = s.pinned.filter((p) => p.id !== id);
      } else if (!s.pinned.some((p) => p.id === id)) {
        const given = body as { title?: string; kind?: NotionPageRef["kind"] } | undefined;
        const known = byId.get(id);
        s.pinned.push(
          known ? refOf(known) : { id, title: given?.title ?? "Untitled", kind: given?.kind ?? "page" },
        );
      }
      return s;
    }
    return undefined;
  };
}
