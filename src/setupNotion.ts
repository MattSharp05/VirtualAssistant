// npm run setup:notion -- --parent <page id or link>
// Creates (once) the two places JARVIS may write, under a page shared with the JARVIS integration:
//   - page "JARVIS Memory" (what JARVIS remembers about Matthew; JD-13)
//   - database "JARVIS Tasks" (the to-do list; JD-9)
// and saves their ids in DATA_DIR/notion.json. Safe to re-run: it reuses what's there.
// The integration needs Read, Insert and Update content.

import { pathToFileURL } from "node:url";
import { NotionApi, normalizeId, notionIdsFile, type Json, type NotionIds } from "./notionWrite.js";
import type { JsonFile } from "./storage.js";

export const MEMORY_TITLE = "JARVIS Memory";
export const TASKS_TITLE = "JARVIS Tasks";

const text = (content: string) => [{ type: "text", text: { content } }];
const options = (names: string[], colors: string[]) => ({ options: names.map((name, i) => ({ name, color: colors[i % colors.length] })) });

export const TASKS_PROPERTIES: Json = {
  Name: { title: {} },
  Status: { select: options(["Suggested", "Open", "Done", "Dismissed"], ["purple", "blue", "green", "gray"]) },
  Due: { date: {} },
  Project: { select: { options: [] } },
  Priority: { select: options(["P1", "P2", "P3"], ["red", "yellow", "gray"]) },
  Source: { select: options(["You", "Slack", "Email", "Session", "Notion QA", "Idea"], ["default", "purple", "red", "blue", "brown", "yellow"]) },
  "Source link": { url: {} },
  "Dedupe key": { rich_text: {} },
  Created: { created_time: {} },
};

/** Still there and not in the trash? */
async function alive(api: NotionApi, kind: "pages" | "databases", id: string | undefined): Promise<boolean> {
  if (!id) return false;
  try {
    const obj = await api.call("GET", `/${kind}/${normalizeId(id)}`);
    return !obj.archived && !obj.in_trash;
  } catch {
    return false;
  }
}

/** A child page / database of the parent with this title (reused instead of making a duplicate). */
async function findChild(api: NotionApi, parentId: string, type: "child_page" | "child_database", title: string): Promise<string | undefined> {
  let cursor: string | undefined;
  do {
    const res = await api.call("GET", `/blocks/${parentId}/children?page_size=100${cursor ? `&start_cursor=${cursor}` : ""}`);
    for (const b of (res.results as Json[]) ?? []) {
      if (b.type === type && String(((b[type] ?? {}) as Json).title ?? "") === title) return normalizeId(String(b.id));
    }
    cursor = res.has_more ? String(res.next_cursor) : undefined;
  } while (cursor);
  return undefined;
}

export interface SetupResult extends NotionIds {
  created: string[];
  reused: string[];
}

export async function setupNotion(api: NotionApi, parent: string, file: JsonFile<NotionIds>): Promise<SetupResult> {
  const parentId = normalizeId(parent);
  if (!/^[0-9a-f]{32}$/.test(parentId)) throw new Error(`"${parent}" isn't a Notion page id or link.`);
  await api.call("GET", `/pages/${parentId}`); // clear error if it isn't shared with the integration
  const saved = file.get();
  const created: string[] = [];
  const reused: string[] = [];

  let memoryPageId = (await alive(api, "pages", saved.memoryPageId)) ? normalizeId(saved.memoryPageId!) : await findChild(api, parentId, "child_page", MEMORY_TITLE);
  if (memoryPageId) reused.push(MEMORY_TITLE);
  else {
    const page = await api.call("POST", "/pages", {
      parent: { page_id: parentId },
      icon: { type: "emoji", emoji: "🧠" },
      properties: { title: { title: text(MEMORY_TITLE) } },
      children: [
        { object: "block", type: "paragraph", paragraph: { rich_text: text("What JARVIS remembers about you. Edit or delete anything; JARVIS reads this page at the start of each conversation.") } },
      ],
    });
    memoryPageId = normalizeId(String(page.id));
    created.push(MEMORY_TITLE);
  }

  let tasksDatabaseId = (await alive(api, "databases", saved.tasksDatabaseId))
    ? normalizeId(saved.tasksDatabaseId!)
    : await findChild(api, parentId, "child_database", TASKS_TITLE);
  if (tasksDatabaseId) reused.push(TASKS_TITLE);
  else {
    const db = await api.call("POST", "/databases", {
      parent: { type: "page_id", page_id: parentId },
      icon: { type: "emoji", emoji: "✅" },
      title: text(TASKS_TITLE),
      properties: TASKS_PROPERTIES,
    });
    tasksDatabaseId = normalizeId(String(db.id));
    created.push(TASKS_TITLE);
  }

  await file.update(() => ({ parentId, memoryPageId, tasksDatabaseId }));
  return { parentId, memoryPageId, tasksDatabaseId, created, reused };
}

// Run as a script: node dist/src/setupNotion.js --parent <id or link>
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const i = process.argv.indexOf("--parent");
  const parent = i > 0 ? process.argv[i + 1] : undefined;
  const token = process.env.NOTION_TOKEN;
  if (!parent || !token) {
    console.error(
      !token ? "NOTION_TOKEN isn't set (it's in JARVIS's .env)." : "Usage: npm run setup:notion -- --parent <Notion page id or link>",
    );
    process.exit(1);
  }
  const file = notionIdsFile(process.env.DATA_DIR ?? "./data");
  setupNotion(new NotionApi(token), parent, file)
    .then((r) => {
      console.log(`Created: ${r.created.join(", ") || "nothing"} · already there: ${r.reused.join(", ") || "nothing"}`);
      console.log(`Saved in ${file.path}. JARVIS picks them up on its next task request (no restart needed).`);
    })
    .catch((err: Error) => {
      console.error(`Setup failed: ${err.message}`);
      process.exit(1);
    });
}
