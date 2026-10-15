// The Notion window's pure logic: list blocks grouped for <ul>/<ol>, the sidebar's lists, labels, and
// what "Ask JARVIS about this page" sends.
import type { NotionBlock, NotionPage, NotionPageRef } from "@jarvis/shared";

export type ListType = "bulleted" | "numbered" | "todo";
const LISTS: readonly string[] = ["bulleted", "numbered", "todo"];

/** A run of list items of one type (one <ul>/<ol>), or any other block on its own. */
export type BlockGroup =
  { kind: "list"; type: ListType; items: NotionBlock[] } | { kind: "block"; block: NotionBlock };

export function groupBlocks(blocks: NotionBlock[]): BlockGroup[] {
  const out: BlockGroup[] = [];
  for (const block of blocks) {
    const last = out[out.length - 1];
    if (LISTS.includes(block.type)) {
      if (last?.kind === "list" && last.type === block.type) last.items.push(block);
      else out.push({ kind: "list", type: block.type as ListType, items: [block] });
    } else out.push({ kind: "block", block });
  }
  return out;
}

/** RECENT leaves out what's already pinned (the mockup's sidebar lists each page once). */
export function recentUnpinned(pinned: NotionPageRef[], recent: NotionPageRef[]): NotionPageRef[] {
  return recent.filter((r) => !pinned.some((p) => p.id === r.id));
}

/** "12 Oct 2026" (the window's locale is en-GB like the mockups). */
export function editedLabel(iso: string | undefined): string | undefined {
  if (!iso) return undefined;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return undefined;
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
}

/** What the page shows under its title: its properties, then when it was last edited. */
export function pageProperties(page: NotionPage): { name: string; value: string }[] {
  const edited = editedLabel(page.editedAt);
  return [...page.properties, ...(edited ? [{ name: "Last edited", value: edited }] : [])];
}

/** The chat message: the title for Matthew, the id so JARVIS reads the right page (notion_read_page). */
export function askAbout(page: Pick<NotionPageRef, "id" | "title" | "kind">): string {
  const what = page.kind === "database" ? "database" : "page";
  return `Read the Notion ${what} “${page.title}” (id ${page.id}) and tell me what matters in it.`;
}

export function isPinned(pinned: NotionPageRef[], id: string): NotionPageRef | undefined {
  return pinned.find((p) => p.id === id);
}
