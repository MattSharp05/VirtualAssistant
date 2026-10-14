// What JARVIS remembers about Matthew, on the JARVIS Memory Notion page (created by setup:notion)
// so he can read and edit it (ADR 0006). The page is bullets under headings ("About Matthew",
// "Preferences", …). The whole page goes into the brain's system prompt; any change publishes
// memory.changed, and the warm brain restarts at its next idle moment to pick it up. Edits Matthew
// makes in Notion are noticed within 10 minutes (poll()).

import type { EventBus } from "./events.js";
import { JarvisError } from "./jarvis.js";
import { NotionApi, NotionWriter, normalizeId, notionIdsFile, type Json, type NotionIds } from "./notionWrite.js";

export const SECTIONS = ["About Matthew", "Preferences", "People", "Projects", "Other"] as const;
export type MemorySection = (typeof SECTIONS)[number];

export const MAX_PROMPT_CHARS = 4000;
const POLL_MS = 10 * 60_000;

export interface MemoryFact {
  id: string;
  section: string;
  text: string;
  createdAt: string;
}

/** Things that look like credentials never go into memory. */
const SECRET_PATTERNS = [
  /\b(password|passcode|passphrase|pin( code)?|api[ _-]?key|secret|token|private key|2fa|otp)\b.{0,12}(is|:|=)/i,
  /\b(sk|pk|rk)-[A-Za-z0-9_-]{12,}/,
  /\b(ghp|gho|github_pat|xox[abpr]|jd|ntn|secret)_[A-Za-z0-9_]{10,}/i,
  /\b(?=[A-Za-z0-9_\-+/=]*\d)(?=[A-Za-z0-9_\-+/=]*[A-Za-z])[A-Za-z0-9_\-+/=]{32,}\b/,
];

export function looksSecret(text: string): boolean {
  return SECRET_PATTERNS.some((re) => re.test(text));
}

const rich = (content: string) => [{ type: "text", text: { content } }];
const plain = (r: unknown) =>
  Array.isArray(r) ? r.map((x) => String((x as Json).plain_text ?? ((x as Json).text as Json | undefined)?.content ?? "")).join("") : "";
const HEADINGS = new Set(["heading_1", "heading_2", "heading_3"]);

function blockText(b: Json): string {
  return plain(((b[String(b.type)] ?? {}) as Json).rich_text).trim();
}

export class MemoryService {
  private ids: NotionIds;
  private readonly writer?: NotionWriter;
  private cache?: { blocks: Json[]; editedAt?: string; checkedAt: number };

  constructor(
    private readonly dataDir: string,
    notionToken: string | undefined,
    private readonly bus?: EventBus,
    fetchImpl: typeof fetch = fetch,
  ) {
    this.ids = notionIdsFile(dataDir).get();
    this.writer = notionToken ? new NotionWriter(new NotionApi(notionToken, fetchImpl), () => this.currentIds()) : undefined;
  }

  private currentIds(): NotionIds {
    if (!this.ids.memoryPageId) this.ids = notionIdsFile(this.dataDir).get();
    return this.ids;
  }

  /** Set up and connected? (Missing memory is never an error for the prompt.) */
  get available(): boolean {
    return Boolean(this.writer && this.currentIds().memoryPageId);
  }

  private page(): { writer: NotionWriter; id: string } {
    if (!this.writer) throw new JarvisError("Notion isn't connected: NOTION_TOKEN is not set in JARVIS's .env.");
    const id = this.currentIds().memoryPageId;
    if (!id) throw new JarvisError("JARVIS Memory isn't set up yet: run `npm run setup:notion -- --parent <page>` on the server (README → Notion).");
    return { writer: this.writer, id };
  }

  private async blocks(fresh = false): Promise<Json[]> {
    if (!fresh && this.cache) return this.cache.blocks;
    const { writer, id } = this.page();
    const [blocks, page] = await Promise.all([writer.listBlocks(id), writer.getPage(id)]);
    this.cache = { blocks, editedAt: page.last_edited_time as string | undefined, checkedAt: Date.now() };
    return blocks;
  }

  /** Every bullet with the heading it sits under. */
  async facts(fresh = false): Promise<MemoryFact[]> {
    const out: MemoryFact[] = [];
    let section = "Other";
    for (const b of await this.blocks(fresh)) {
      if (HEADINGS.has(String(b.type))) section = blockText(b) || section;
      else if (b.type === "bulleted_list_item" && blockText(b)) out.push({ id: normalizeId(String(b.id)), section, text: blockText(b), createdAt: String(b.created_time ?? "") });
    }
    return out;
  }

  async remember(fact: string, section: MemorySection = "Other"): Promise<MemoryFact> {
    const text = fact.trim().replace(/\s+/g, " ");
    if (!text) throw new JarvisError("Nothing to remember.");
    if (text.length > 500) throw new JarvisError("That's long for a memory; keep it to one short fact.");
    if (looksSecret(text)) throw new JarvisError("That looks like a password or key. I don't store secrets in memory; keep it in a password manager.");
    if (!SECTIONS.includes(section)) section = "Other";
    const { writer, id } = this.page();
    const blocks = await this.blocks(true);
    const known = (await this.facts()).find((f) => f.text.toLowerCase() === text.toLowerCase());
    if (known) return known;

    const bullet = { object: "block", type: "bulleted_list_item", bulleted_list_item: { rich_text: rich(text) } };
    const headingAt = blocks.findIndex((b) => HEADINGS.has(String(b.type)) && blockText(b).toLowerCase() === section.toLowerCase());
    let made: Json[];
    if (headingAt === -1) {
      made = await writer.appendBlocks(id, [{ object: "block", type: "heading_2", heading_2: { rich_text: rich(section) } }, bullet]);
    } else {
      // After the heading's last bullet (the section ends at the next heading).
      let last = headingAt;
      while (last + 1 < blocks.length && !HEADINGS.has(String(blocks[last + 1].type))) last++;
      made = await writer.appendBlocks(id, [bullet], String(blocks[last].id));
    }
    const added = made.at(-1)!;
    this.changed();
    return { id: normalizeId(String(added.id)), section, text, createdAt: String(added.created_time ?? new Date().toISOString()) };
  }

  /** Bullets matching the query: all words first, then any word (3+ letters). */
  async recall(query: string): Promise<MemoryFact[]> {
    const facts = await this.facts(this.stale());
    const q = query.trim().toLowerCase();
    if (!q) return facts;
    const words = q.split(/\W+/).filter((w) => w.length >= 3);
    const score = (f: MemoryFact) => {
      const t = `${f.section} ${f.text}`.toLowerCase();
      if (t.includes(q)) return 100;
      return words.filter((w) => t.includes(w)).length;
    };
    return facts
      .map((f) => ({ f, s: score(f) }))
      .filter((x) => x.s > 0)
      .sort((a, b) => b.s - a.s)
      .map((x) => x.f);
  }

  /** Deletes a bullet by id, or by text that matches exactly one bullet. */
  async forget(factOrId: string): Promise<MemoryFact> {
    const facts = await this.facts(true);
    const key = factOrId.trim();
    let match = facts.find((f) => f.id === normalizeId(key));
    if (!match) {
      const q = key.toLowerCase();
      const hits = facts.filter((f) => f.text.toLowerCase().includes(q) || q.includes(f.text.toLowerCase()));
      if (!hits.length) throw new JarvisError(`Nothing in memory matches "${key}".`);
      if (hits.length > 1) throw new JarvisError(`"${key}" matches ${hits.length} memories: ${hits.map((h) => `${h.text} (${h.id})`).join("; ")}. Say which.`);
      match = hits[0];
    }
    await this.page().writer.deleteBlock(match.id);
    this.changed();
    return match;
  }

  /** The page as markdown for the system prompt (≤ 4,000 chars; newest bullets win). */
  async promptText(): Promise<string | undefined> {
    if (!this.available) return undefined;
    const facts = await this.facts(this.stale());
    if (!facts.length) return undefined;
    let kept = [...facts];
    const render = (list: MemoryFact[]) => {
      const sections = [...new Set(list.map((f) => f.section))];
      return sections.map((s) => `## ${s}\n${list.filter((f) => f.section === s).map((f) => `- ${f.text}`).join("\n")}`).join("\n\n");
    };
    let text = render(kept);
    if (text.length > MAX_PROMPT_CHARS) {
      const newestFirst = [...facts].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      while (text.length > MAX_PROMPT_CHARS && kept.length > 1) {
        const oldest = newestFirst[kept.length - 1];
        kept = kept.filter((f) => f.id !== oldest.id);
        text = render(kept);
      }
      console.warn(`JARVIS Memory is over ${MAX_PROMPT_CHARS} characters: the brain sees the newest ${kept.length} of ${facts.length} facts.`);
    }
    return text;
  }

  /** Checks whether Matthew edited the page in Notion; if so, refreshes and publishes memory.changed. */
  async poll(): Promise<boolean> {
    if (!this.available || !this.cache) return false;
    const { writer, id } = this.page();
    const page = await writer.getPage(id);
    this.cache.checkedAt = Date.now();
    if (page.last_edited_time === this.cache.editedAt) return false;
    await this.blocks(true);
    this.bus?.publish({ type: "memory.changed" });
    return true;
  }

  private stale(): boolean {
    return !this.cache || Date.now() - this.cache.checkedAt > POLL_MS;
  }

  private changed(): void {
    this.cache = undefined;
    this.bus?.publish({ type: "memory.changed" });
  }
}

const services = new WeakMap<object, MemoryService>();

export function memoryFor(owner: object, make: () => MemoryService): MemoryService {
  let s = services.get(owner);
  if (!s) services.set(owner, (s = make()));
  return s;
}

export function useMemoryService(owner: object, service: MemoryService): void {
  services.set(owner, service);
}

export { POLL_MS as MEMORY_POLL_MS };
