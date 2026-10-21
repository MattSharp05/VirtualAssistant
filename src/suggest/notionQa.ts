// Suggestions from Notion QA (no LLM): every project's Tickets database shared with the integration;
// each ticket with Status = QA Pending becomes its own suggestion (JD-83), linked straight to that
// ticket's own Notion page so the To-do window can show and pull in its Acceptance Criteria checklist.
// The key is the project plus the ticket id, so a ticket leaving QA Pending drops its suggestion
// (Suggester.notionQa()'s reconciliation already works per dedupe key, not per batch).
import { titleOf } from "../notion.js";
import type { Json, NotionApi } from "../notionWrite.js";
import type { NewSuggestion } from "../tasks.js";

export const QA_STATUS = "QA Pending";

export interface QaScan {
  suggestions: NewSuggestion[];
  /** Projects whose Tickets were read (a project that failed to read keeps its suggestion). */
  projects: Set<string>;
}

/** "JD-22" from a unique_id property (Ticket ID), else the ticket's title. */
function ticketId(row: Json): string {
  for (const prop of Object.values((row.properties ?? {}) as Record<string, Json>)) {
    if (prop.type !== "unique_id") continue;
    const u = (prop.unique_id ?? {}) as Json;
    if (u.number !== null && u.number !== undefined) return u.prefix ? `${String(u.prefix)}-${String(u.number)}` : String(u.number);
  }
  return titleOf(row);
}

/** The page a database sits on (one hop up for a database inside a block), as project name + link. */
async function projectOf(api: NotionApi, db: Json): Promise<{ name: string; url?: string }> {
  try {
    let parent = (db.parent ?? {}) as Json;
    if (parent.type === "block_id") parent = ((await api.call("GET", `/blocks/${String(parent.block_id)}`)).parent ?? {}) as Json;
    if (parent.type === "page_id") {
      const page = await api.call("GET", `/pages/${String(parent.page_id)}`);
      return { name: titleOf(page), ...(page.url ? { url: String(page.url) } : {}) };
    }
  } catch {
    // fall through: named after the database
  }
  return { name: titleOf(db).replace(/\s*tickets\s*/i, "").trim() || "Notion", ...(db.url ? { url: String(db.url) } : {}) };
}

/** Tickets databases the integration can see (any database titled "Tickets" with a Status). */
async function ticketDatabases(api: NotionApi): Promise<Json[]> {
  const out: Json[] = [];
  let cursor: string | undefined;
  do {
    const res = await api.call("POST", "/search", {
      query: "Tickets",
      filter: { property: "object", value: "database" },
      page_size: 100,
      ...(cursor ? { start_cursor: cursor } : {}),
    });
    for (const db of (res.results as Json[]) ?? []) {
      const status = ((db.properties ?? {}) as Record<string, Json>).Status;
      if (/^tickets$/i.test(titleOf(db).trim()) && status && !db.archived && !db.in_trash) out.push(db);
    }
    cursor = res.has_more ? String(res.next_cursor) : undefined;
  } while (cursor && out.length < 50);
  return out;
}

export async function notionQaSuggestions(api: NotionApi): Promise<QaScan> {
  const scan: QaScan = { suggestions: [], projects: new Set() };
  for (const db of await ticketDatabases(api)) {
    const project = await projectOf(api, db);
    let rows: Json[];
    try {
      const type = String((((db.properties ?? {}) as Record<string, Json>).Status as Json).type ?? "select");
      const res = await api.call("POST", `/databases/${String(db.id)}/query`, { filter: { property: "Status", [type]: { equals: QA_STATUS } }, page_size: 100 });
      rows = (res.results as Json[]) ?? [];
    } catch (err) {
      console.warn(`suggestions: couldn't read ${project.name}'s Tickets: ${(err as Error).message}`);
      continue;
    }
    scan.projects.add(project.name);
    for (const row of rows) {
      const id = ticketId(row);
      scan.suggestions.push({
        name: `QA ${id}: ${titleOf(row)}`,
        source: "Notion QA",
        ...(row.url ? { link: String(row.url) } : project.url ? { link: project.url } : {}),
        dedupeKey: `notionqa:${project.name}:${id}`,
        why: `${id} is waiting for your QA in ${project.name}.`,
        project: project.name,
      });
    }
  }
  return scan;
}
